/**
 * Applying a plan to a working tree, and taking it back off again.
 *
 * The design and the reasoning behind the commit order are in ARCHITECTURE.md under
 * "The transaction". The part worth knowing before reading this file: the manifest
 * is written before anything is touched, so an interrupted run always leaves behind
 * a record of what it was in the middle of.
 *
 * A plan and a manifest are deliberately different types. The plan holds the edits
 * that go forward and lives only in memory; the manifest holds the edits that come
 * back and is the only thing undo reads. Nothing needs to redo an interrupted run,
 * so nothing stores what it would take to.
 */

import { applyEdits, invertEdits, validateEdits } from './edits.js';
import { UpflyError } from './errors.js';
import {
  type CreateOperation,
  type Declined,
  type DeleteOperation,
  MANIFEST_PATH,
  MANIFEST_SCHEMA_VERSION,
  type Manifest,
  type MoveOperation,
  type Operation,
  parseManifest,
  serialiseManifest,
} from './manifest.js';
import type { Edit } from './types.js';

/**
 * Everything the transaction is allowed to do to a disk.
 *
 * Injected the same way as the resolver's `exists` and the probe's decoder, for the
 * usual reason and one extra: a fake store can be told to fail on the nth write,
 * which is how the crash tests interrupt a commit through the same code path a real
 * crash would take.
 *
 * Every path is POSIX-relative to the project root. Nothing above this port sees an
 * absolute path, which is also why no absolute path reaches the manifest.
 */
export interface FileStore {
  /**
   * Names the function `hash` uses, so the manifest can record it.
   *
   * It comes from the store rather than from a constant here, which is what stops a
   * manifest ever naming an algorithm other than the one that made its hashes.
   */
  readonly hashAlgorithm: string;
  /** Content hash, or null when the path does not exist. */
  hash(path: string): Promise<string | null>;
  readText(path: string): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

/**
 * An edit as planned, carrying the direction that goes on to disk.
 *
 * The manifest stores the reverse of this. Keeping the two apart means there is no
 * moment where the same information is written down twice and could disagree.
 */
export interface PlannedEdit {
  readonly kind: 'edit';
  readonly path: string;
  readonly beforeHash: string;
  readonly afterHash: string;
  readonly edits: readonly Edit[];
}

export type PlannedOperation = CreateOperation | PlannedEdit | MoveOperation | DeleteOperation;

/** Identity and bookkeeping for one run. */
export interface RunContext {
  readonly runId: string;
  /** POSIX-relative to the project root, holding staged bytes and backups. */
  readonly runDir: string;
  /** Injected so a test can pin the timestamps a real run cannot. */
  readonly now: () => string;
  readonly declined: readonly Declined[];
}

/** What the disk says about one operation right now. */
export type OperationStatus =
  /** Done. Undo has work to do. */
  | 'applied'
  /** A move whose copy landed but whose source is still there. */
  | 'partial'
  /** Never happened. Undo has nothing to do. */
  | 'not-applied'
  /**
   * The file matches neither the before state nor the after state, so something
   * other than this run changed it. The transaction will not touch it: silently
   * writing over somebody's work is worse than leaving a run half applied, and they
   * cannot fix what they are never told about.
   */
  | 'foreign';

export interface OperationState {
  readonly operation: Operation;
  readonly status: OperationStatus;
  /** The path the status was decided on, so a foreign report can point at it. */
  readonly path: string;
}

/**
 * Check a plan against the tree it is about to be applied to.
 *
 * Everything knowable before writing is checked here, because a failure here costs
 * nothing and the same failure during commit costs a half-changed tree.
 *
 * @throws {UpflyError} `TRANSACTION_PLAN_INVALID` naming the operation and the problem.
 */
export async function prepare(
  plan: readonly PlannedOperation[],
  store: FileStore,
  runDir: string,
): Promise<void> {
  const claimed = new Map<string, string>();

  const claim = (path: string, by: string): void => {
    const existing = claimed.get(path);
    if (existing !== undefined) {
      throw new UpflyError(
        'TRANSACTION_PLAN_INVALID',
        `Two operations both target ${path}: ${existing} and ${by}. The result would depend on which ran first.`,
      );
    }
    claimed.set(path, by);
  };

  for (const operation of plan) {
    switch (operation.kind) {
      case 'create': {
        claim(operation.path, 'create');
        await expectAbsent(store, operation.path, 'create');
        await expectStaged(store, runDir, operation.staged, 'create');
        break;
      }
      case 'edit': {
        claim(operation.path, 'edit');
        await expectHash(store, operation.path, operation.beforeHash, 'edit');
        await checkUndoable(store, operation);
        break;
      }
      case 'move': {
        claim(operation.from, 'move source');
        claim(operation.to, 'move destination');
        await expectHash(store, operation.from, operation.hash, 'move');
        await expectAbsent(store, operation.to, 'move');
        break;
      }
      case 'delete': {
        claim(operation.path, 'delete');
        await expectHash(store, operation.path, operation.beforeHash, 'delete');
        // A delete is the only operation whose bytes nothing else in the manifest
        // can reconstruct. The type demands a backup path; this demands the file
        // actually be there, since a field can be filled in with a path nobody wrote.
        await expectStaged(store, runDir, operation.backup, 'delete');
        break;
      }
      default: {
        const unhandled: never = operation;
        return unhandled;
      }
    }
  }
}

/**
 * Apply a prepared plan.
 *
 * Commit owns the manifest from beginning to end, so no caller is in a position to
 * write it last. The phase order is what keeps an interrupted run buildable: files
 * appear before anything points at them, and originals go only once nothing points
 * at them any more.
 *
 * Every edit target is hashed again at the moment it is read, rather than trusting
 * the identical check `prepare` made: encoding runs between the two, so that check
 * is only as fresh as however long the images took.
 */
export async function commit(
  plan: readonly PlannedOperation[],
  store: FileStore,
  context: RunContext,
): Promise<Manifest> {
  const pending: Manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    hashAlgorithm: store.hashAlgorithm,
    runId: context.runId,
    startedAt: context.now(),
    completedAt: null,
    revertedAt: null,
    state: 'pending',
    runDir: context.runDir,
    operations: await manifestOperations(plan, store),
    declined: context.declined,
  };
  await store.writeText(MANIFEST_PATH, serialiseManifest(pending));

  for (const operation of plan) {
    if (operation.kind === 'create') {
      await store.copy(`${context.runDir}/${operation.staged}`, operation.path);
    } else if (operation.kind === 'move') {
      await store.copy(operation.from, operation.to);
    }
  }

  for (const operation of plan) {
    if (operation.kind !== 'edit') continue;
    const before = await readVerified(store, operation.path, operation.beforeHash);
    await store.writeText(operation.path, applyEdits(before, operation.edits));
  }

  for (const operation of plan) {
    if (operation.kind === 'delete') await store.remove(operation.path);
    else if (operation.kind === 'move') await store.remove(operation.from);
  }

  const committed: Manifest = { ...pending, state: 'committed', completedAt: context.now() };
  await store.writeText(MANIFEST_PATH, serialiseManifest(committed));
  return committed;
}

/**
 * Decide, by hashing, what actually happened to each operation.
 *
 * This is why commit keeps no journal of its own progress. Every operation records
 * the hash on both sides, so the state of the tree is enough to say whether it ran,
 * and nothing depends on how far a counter got before the process died.
 */
export async function inspect(
  manifest: Manifest,
  store: FileStore,
): Promise<readonly OperationState[]> {
  requireSameHashFunction(manifest, store);
  const states: OperationState[] = [];

  for (const operation of manifest.operations) {
    switch (operation.kind) {
      case 'create': {
        const current = await store.hash(operation.path);
        states.push({
          operation,
          path: operation.path,
          status: presenceStatus(current, operation.afterHash),
        });
        break;
      }
      case 'edit': {
        const current = await store.hash(operation.path);
        states.push({
          operation,
          path: operation.path,
          status: betweenStatus(current, operation.beforeHash, operation.afterHash),
        });
        break;
      }
      case 'move': {
        states.push({ operation, path: operation.to, status: await moveStatus(operation, store) });
        break;
      }
      case 'delete': {
        const current = await store.hash(operation.path);
        states.push({
          operation,
          path: operation.path,
          status: absenceStatus(current, operation.beforeHash),
        });
        break;
      }
      default: {
        const unhandled: never = operation;
        return unhandled;
      }
    }
  }
  return states;
}

/**
 * Put the tree back the way it was.
 *
 * There is deliberately no separate function for recovering an interrupted run.
 * Undoing a finished run and cleaning up an interrupted one are the same job:
 * reverse whatever the disk says actually happened. One path means there is no
 * rarely-exercised recovery branch left to be wrong.
 *
 * @throws {UpflyError} `TRANSACTION_FOREIGN_CHANGE` naming every file changed by
 *         something other than this run. Nothing is reverted in that case, so the
 *         tree is never left in a third state nobody planned.
 */
export async function revert(
  manifest: Manifest,
  store: FileStore,
  now: () => string = () => new Date().toISOString(),
): Promise<Manifest> {
  const states = await inspect(manifest, store);
  const foreign = states.filter((state) => state.status === 'foreign');

  if (foreign.length > 0) {
    throw new UpflyError(
      'TRANSACTION_FOREIGN_CHANGE',
      `${foreign.length} file(s) changed since this run: ${foreign
        .map((state) => state.path)
        .join(
          ', ',
        )}. Nothing was reverted, because undoing over somebody else's edit would lose it.`,
    );
  }

  // The mirror of commit's phases, and it has to be, for the same reason: originals
  // come back before anything points at them again, and what the run created goes
  // only once nothing points at it.
  await restoreOriginals(states, manifest, store);
  await undoEdits(states, store);
  await removeCreated(states, store);

  const reverted: Manifest = {
    ...manifest,
    state: 'reverted',
    // Keep the first undo's time. Running revert again on an already-reverted
    // manifest does nothing, and stamping a fresh time would claim otherwise.
    revertedAt: manifest.revertedAt ?? now(),
  };
  await store.writeText(MANIFEST_PATH, serialiseManifest(reverted));
  return reverted;
}

/** Undo's first phase: put back what the run took away. */
async function restoreOriginals(
  states: readonly OperationState[],
  manifest: Manifest,
  store: FileStore,
): Promise<void> {
  for (const state of states) {
    if (state.status === 'not-applied') continue;
    if (state.operation.kind === 'delete') {
      await store.copy(`${manifest.runDir}/${state.operation.backup}`, state.operation.path);
    } else if (state.operation.kind === 'move' && state.status === 'applied') {
      // A `partial` move still has its source, so only a completed one needs the
      // bytes copied back from the destination.
      await store.copy(state.operation.to, state.operation.from);
    }
  }
}

/** Undo's second phase: point the references back at the originals. */
async function undoEdits(states: readonly OperationState[], store: FileStore): Promise<void> {
  for (const state of states) {
    if (state.status !== 'applied' || state.operation.kind !== 'edit') continue;
    const current = await store.readText(state.operation.path);
    await store.writeText(state.operation.path, applyEdits(current, state.operation.inverse));
  }
}

/** Undo's third phase: take away what the run added, now that nothing names it. */
async function removeCreated(states: readonly OperationState[], store: FileStore): Promise<void> {
  for (const state of states) {
    if (state.status === 'not-applied') continue;
    if (state.operation.kind === 'create') await store.remove(state.operation.path);
    else if (state.operation.kind === 'move') await store.remove(state.operation.to);
  }
}

/** Read the manifest of the last run, or null when there has not been one. */
export async function readManifest(store: FileStore): Promise<Manifest | null> {
  if ((await store.hash(MANIFEST_PATH)) === null) return null;
  const manifest = parseManifest(await store.readText(MANIFEST_PATH));

  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new UpflyError(
      'MANIFEST_VERSION_UNSUPPORTED',
      `Manifest is schema version ${manifest.schemaVersion} and this build understands ${MANIFEST_SCHEMA_VERSION}. Undo it with the version that wrote it.`,
    );
  }
  return manifest;
}

/** Turn the forward plan into the reverse record the manifest keeps. */
async function manifestOperations(
  plan: readonly PlannedOperation[],
  store: FileStore,
): Promise<Operation[]> {
  const operations: Operation[] = [];

  for (const operation of plan) {
    if (operation.kind !== 'edit') {
      operations.push(operation);
      continue;
    }
    const before = await readVerified(store, operation.path, operation.beforeHash);
    operations.push({
      kind: 'edit',
      path: operation.path,
      beforeHash: operation.beforeHash,
      afterHash: operation.afterHash,
      inverse: invertEdits(before, operation.edits),
    });
  }
  return operations;
}

/**
 * Refuse to compare hashes that were not made the same way.
 *
 * Every status below is decided by comparing a stored hash against a fresh one. If
 * the two came from different functions none of them match, so every file would be
 * reported as changed by somebody else. That is the most alarming thing this tool
 * can say, and it would be entirely an artefact of the mismatch.
 */
function requireSameHashFunction(manifest: Manifest, store: FileStore): void {
  if (manifest.hashAlgorithm === store.hashAlgorithm) return;
  throw new UpflyError(
    'MANIFEST_VERSION_UNSUPPORTED',
    `The manifest's hashes were made with ${manifest.hashAlgorithm} and this build uses ${store.hashAlgorithm}, so none of them can be checked. Undo it with the version that wrote it.`,
  );
}

/** A file the run was to put there: absent means it never ran. */
function presenceStatus(current: string | null, afterHash: string): OperationStatus {
  if (current === null) return 'not-applied';
  return current === afterHash ? 'applied' : 'foreign';
}

/** A file the run was to rewrite: it should hold one of the two texts we know. */
function betweenStatus(
  current: string | null,
  beforeHash: string,
  afterHash: string,
): OperationStatus {
  if (current === afterHash) return 'applied';
  return current === beforeHash ? 'not-applied' : 'foreign';
}

/** A file the run was to remove: absent means it ran. */
function absenceStatus(current: string | null, beforeHash: string): OperationStatus {
  if (current === null) return 'applied';
  return current === beforeHash ? 'not-applied' : 'foreign';
}

async function moveStatus(operation: MoveOperation, store: FileStore): Promise<OperationStatus> {
  const from = await store.hash(operation.from);
  const to = await store.hash(operation.to);

  if (from === operation.hash && to === null) return 'not-applied';
  if (from === operation.hash && to === operation.hash) return 'partial';
  if (from === null && to === operation.hash) return 'applied';
  return 'foreign';
}

async function expectAbsent(store: FileStore, path: string, kind: string): Promise<void> {
  if ((await store.hash(path)) !== null) {
    throw new UpflyError(
      'TRANSACTION_PLAN_INVALID',
      `${kind} would write ${path}, which already exists. Overwriting a file nobody planned to overwrite is how a tool loses somebody's work.`,
    );
  }
}

async function expectHash(
  store: FileStore,
  path: string,
  expected: string,
  kind: string,
): Promise<void> {
  const current = await store.hash(path);
  if (current === null) {
    throw new UpflyError(
      'TRANSACTION_PLAN_INVALID',
      `${kind} names ${path}, which does not exist.`,
    );
  }
  if (current !== expected) {
    throw new UpflyError(
      'TRANSACTION_PLAN_INVALID',
      `${path} changed between planning and now. Re-run the audit rather than applying a plan built on stale content.`,
    );
  }
}

/**
 * Read an edit target, refusing it when the bytes are no longer the ones planned.
 *
 * `prepare` checks this same hash, but it can be a long way earlier: encoding runs
 * between them, and an editor saving the file in that window leaves edit offsets
 * that no longer describe the text. Applying them writes something nobody planned,
 * and the inverse derived from the same read would not fit the file either, so the
 * undo recorded in the manifest would be wrong in the same stroke. `inspect` calls
 * the result `foreign` afterwards, which detects the damage rather than preventing
 * it, and the file it detects it on is somebody's unsaved work.
 */
async function readVerified(store: FileStore, path: string, expected: string): Promise<string> {
  if ((await store.hash(path)) !== expected) {
    throw new UpflyError(
      'TRANSACTION_FOREIGN_CHANGE',
      `${path} changed after the plan was checked, so it was not rewritten. Re-run the audit rather than applying a plan built on text that has moved.`,
    );
  }
  return store.readText(path);
}

async function expectStaged(
  store: FileStore,
  runDir: string,
  staged: string,
  kind: string,
): Promise<void> {
  if ((await store.hash(`${runDir}/${staged}`)) === null) {
    throw new UpflyError(
      'TRANSACTION_PLAN_INVALID',
      `${kind} refers to ${staged} in the run directory, which was never written.`,
    );
  }
}

/**
 * Refuse a plan whose undo would not apply.
 *
 * Two adjacent edits where the first removes text can invert into two edits sharing
 * a start offset, which `applyEdits` rejects. Discovering that during undo would
 * mean discovering it when the tree is already changed and somebody is asking for
 * their work back, so it is settled while nothing has happened yet.
 */
async function checkUndoable(store: FileStore, operation: PlannedEdit): Promise<void> {
  const before = await store.readText(operation.path);
  const after = applyEdits(before, operation.edits);
  const inverse = invertEdits(before, operation.edits);

  try {
    validateEdits(after, inverse);
  } catch (cause) {
    throw new UpflyError(
      'TRANSACTION_PLAN_INVALID',
      `The undo for ${operation.path} could not be applied: ${(cause as Error).message}`,
    );
  }

  if (applyEdits(after, inverse) !== before) {
    throw new UpflyError(
      'TRANSACTION_PLAN_INVALID',
      `The undo for ${operation.path} does not restore the original text.`,
    );
  }
}
