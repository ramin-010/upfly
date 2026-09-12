import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UpflyError } from './errors.js';
import { createNodeFileStore } from './file-store-node.js';
import { MANIFEST_PATH, MANIFEST_VOLATILE_FIELDS, withoutVolatileFields } from './manifest.js';
import {
  type FileStore,
  type PlannedOperation,
  type RunContext,
  commit,
  inspect,
  prepare,
  revert,
} from './transaction.js';

const RUN_DIR = '.upfly/runs/r1';

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

interface Harness {
  readonly store: FileStore;
  readonly files: Map<string, string>;
  mutations(): number;
  /** A crash ends a process; the next one starts with a disk that works again. */
  stopFailing(): void;
}

/**
 * Wrap a store so it can be told to die partway through.
 *
 * The count is of operations that change something: a write, a copy, a removal.
 * Injecting the failure here rather than calling revert directly is the point of the
 * whole exercise, because it interrupts commit on the same code path a real crash
 * would.
 *
 * Separate from any one store so that both the in-memory double and the real
 * filesystem store are interrupted by the same mechanism at the same points. While
 * this lived inside the memory store, every crash test in the project ran against
 * semantics the real store does not have.
 */
function interruptible(store: FileStore): {
  readonly store: FileStore;
  mutations(): number;
  failAfter(count: number): void;
  stopFailing(): void;
} {
  let mutations = 0;
  let limit = Number.POSITIVE_INFINITY;

  const mutate = (): void => {
    mutations += 1;
    if (mutations > limit) throw new Error(`injected failure at mutation ${mutations}`);
  };

  return {
    mutations: () => mutations,
    failAfter: (count) => {
      mutations = 0;
      limit = count;
    },
    stopFailing: () => {
      limit = Number.POSITIVE_INFINITY;
    },
    store: {
      hashAlgorithm: store.hashAlgorithm,
      hash: (path) => store.hash(path),
      readText: (path) => store.readText(path),
      async writeText(path, text) {
        mutate();
        await store.writeText(path, text);
      },
      async copy(from, to) {
        mutate();
        await store.copy(from, to);
      },
      async remove(path) {
        mutate();
        await store.remove(path);
      },
    },
  };
}

/** A bare in-memory store, with the failure injection left to `interruptible`. */
function memoryFiles(files: Map<string, string>): FileStore {
  return {
    hashAlgorithm: 'sha256',
    async hash(path) {
      const text = files.get(path);
      return text === undefined ? null : sha(text);
    },
    async readText(path) {
      const text = files.get(path);
      if (text === undefined) throw new Error(`no such file: ${path}`);
      return text;
    },
    async writeText(path, text) {
      files.set(path, text);
    },
    async copy(from, to) {
      const text = files.get(from);
      if (text === undefined) throw new Error(`no such file: ${from}`);
      files.set(to, text);
    },
    async remove(path) {
      files.delete(path);
    },
  };
}

function memoryStore(
  initial: Record<string, string>,
  failAfter = Number.POSITIVE_INFINITY,
): Harness {
  const files = new Map(Object.entries(initial));
  const interrupted = interruptible(memoryFiles(files));
  interrupted.failAfter(failAfter);

  return {
    files,
    store: interrupted.store,
    mutations: interrupted.mutations,
    stopFailing: interrupted.stopFailing,
  };
}

/** A tree exercising all four operation kinds at once. */
function tree(runDir = RUN_DIR): Record<string, string> {
  return {
    'src/App.jsx': 'import logo from "./logo.png";\nexport const alt = "./logo.png";\n',
    'src/logo.png': 'PNG-BYTES',
    'public/hero.png': 'HERO-BYTES',
    'images/old.png': 'OLD-BYTES',
    [`${runDir}/staged/logo.webp`]: 'WEBP-BYTES',
    [`${runDir}/backup/old.png`]: 'OLD-BYTES',
  };
}

/**
 * The plan. The two edits inside `App.jsx` are deliberate: a single reference would
 * not exercise the offset shifting that inverting a multi-edit rewrite depends on.
 */
function plan(): PlannedOperation[] {
  const text = tree()['src/App.jsx'] as string;
  const first = text.indexOf('./logo.png');
  const second = text.indexOf('./logo.png', first + 1);
  const edits = [
    { start: first, end: first + './logo.png'.length, replacement: './logo.webp' },
    { start: second, end: second + './logo.png'.length, replacement: './logo.webp' },
  ];
  const after = `${text.slice(0, first)}./logo.webp${text.slice(first + 10, second)}./logo.webp${text.slice(second + 10)}`;

  return [
    {
      kind: 'create',
      path: 'src/logo.webp',
      staged: 'staged/logo.webp',
      afterHash: sha('WEBP-BYTES'),
    },
    { kind: 'edit', path: 'src/App.jsx', beforeHash: sha(text), afterHash: sha(after), edits },
    {
      kind: 'move',
      from: 'public/hero.png',
      to: 'public/images/hero.png',
      hash: sha('HERO-BYTES'),
    },
    {
      kind: 'delete',
      path: 'images/old.png',
      beforeHash: sha('OLD-BYTES'),
      backup: 'backup/old.png',
    },
  ];
}

function context(): RunContext {
  let tick = 0;
  return {
    runId: 'r1',
    runDir: RUN_DIR,
    now: () => `2026-01-01T00:00:0${tick++}.000Z`,
    declined: [
      {
        path: 'src/data/logos.ts',
        line: 55,
        reason: 'the reference is assembled at runtime and cannot be rewritten safely',
      },
    ],
  };
}

/** The project's own files, with the run directory and the manifest left out. */
function projectFiles(files: ReadonlyMap<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, text] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    if (path.startsWith('.upfly/')) continue;
    out[path] = text;
  }
  return out;
}

describe('prepare', () => {
  it('accepts a plan whose operations each target a different path', async () => {
    const harness = memoryStore(tree());
    await expect(prepare(plan(), harness.store, RUN_DIR)).resolves.toBeUndefined();
  });

  it('refuses two operations that target the same path', async () => {
    const harness = memoryStore(tree());
    const clash: PlannedOperation[] = [
      ...plan(),
      { kind: 'delete', path: 'src/App.jsx', beforeHash: sha('x'), backup: 'backup/old.png' },
    ];
    await expect(prepare(clash, harness.store, RUN_DIR)).rejects.toThrow(
      /both target src\/App\.jsx/,
    );
  });

  it('refuses two creates whose paths differ only in case, which are one file on Windows', async () => {
    // Neither file exists yet, so the absent check passes for both and only this
    // catches it. Comparing paths exactly let the second create land on top of the
    // first and the run reported success.
    const harness = memoryStore(tree());
    const clash: PlannedOperation[] = [
      ...plan(),
      { kind: 'create', path: 'src/LOGO.webp', staged: 'staged/LOGO.webp', afterHash: sha('n') },
    ];

    await expect(prepare(clash, harness.store, RUN_DIR)).rejects.toThrow(
      /are the same file on Windows and macOS/,
    );
  });

  it('refuses a delete whose backup was never written', async () => {
    const files = tree();
    delete files[`${RUN_DIR}/backup/old.png`];
    const harness = memoryStore(files);

    await expect(prepare(plan(), harness.store, RUN_DIR)).rejects.toThrow(
      /backup\/old\.png in the run directory, which was never written/,
    );
  });

  it('refuses a create whose destination already exists', async () => {
    const files = { ...tree(), 'src/logo.webp': 'SOMETHING-ELSE' };
    const harness = memoryStore(files);

    await expect(prepare(plan(), harness.store, RUN_DIR)).rejects.toThrow(/which already exists/);
  });

  it('refuses a plan built on content that has since changed', async () => {
    const files = { ...tree(), 'src/App.jsx': 'something a person edited after the audit\n' };
    const harness = memoryStore(files);

    await expect(prepare(plan(), harness.store, RUN_DIR)).rejects.toThrow(
      /changed between planning and now/,
    );
  });

  it('refuses a plan whose undo would not apply', async () => {
    // A deletion immediately followed by a replacement inverts into two edits that
    // share a start offset, which applyEdits rejects. Catching it here is the whole
    // reason prepare checks the inverse rather than trusting it.
    const harness = memoryStore({ 'a.css': 'abcdef', [`${RUN_DIR}/staged/x`]: 'x' });
    const bad: PlannedOperation[] = [
      {
        kind: 'edit',
        path: 'a.css',
        beforeHash: sha('abcdef'),
        afterHash: sha('Xcdef'),
        edits: [
          { start: 0, end: 1, replacement: '' },
          { start: 1, end: 2, replacement: 'X' },
        ],
      },
    ];
    await expect(prepare(bad, harness.store, RUN_DIR)).rejects.toThrow(/undo for a\.css/);
  });
});

describe('commit', () => {
  it('writes the manifest before it touches a single file', async () => {
    // Allow exactly one mutation, then die. Whichever mutation that was is the one
    // commit does first, and it has to be the manifest: a changed tree with no
    // manifest is the single state undo cannot get out of.
    //
    // Asserting the manifest is present matters more than asserting the tree is
    // clean. An earlier version of this test crashed at mutation zero and only
    // checked the tree, which passes whatever the order is, because nothing has
    // happened yet either way. It was named after a property it did not test.
    const harness = memoryStore(tree(), 1);
    await expect(commit(plan(), harness.store, context())).rejects.toThrow(/injected failure/);

    expect(harness.files.has(MANIFEST_PATH)).toBe(true);
    expect(projectFiles(harness.files)).toEqual(projectFiles(new Map(Object.entries(tree()))));
  });

  it('applies every operation and records them all', async () => {
    const harness = memoryStore(tree());
    const manifest = await commit(plan(), harness.store, context());

    expect(manifest.state).toBe('committed');
    expect(manifest.operations).toHaveLength(4);
    expect(harness.files.get('src/logo.webp')).toBe('WEBP-BYTES');
    expect(harness.files.get('src/App.jsx')).toContain('./logo.webp');
    expect(harness.files.get('src/App.jsx')).not.toContain('./logo.png');
    expect(harness.files.get('public/images/hero.png')).toBe('HERO-BYTES');
    expect(harness.files.has('public/hero.png')).toBe(false);
    expect(harness.files.has('images/old.png')).toBe(false);
  });

  it('carries every declined item into the manifest', async () => {
    const harness = memoryStore(tree());
    const manifest = await commit(plan(), harness.store, context());

    expect(manifest.declined).toEqual([
      {
        path: 'src/data/logos.ts',
        line: 55,
        reason: 'the reference is assembled at runtime and cannot be rewritten safely',
      },
    ]);
  });
});

/**
 * Both windows in which a file can move under a run that already checked it.
 *
 * The replacement text is chosen to be the same length as the original in both
 * tests, so the planned offsets still land inside the file and every other check
 * still passes. That is the version worth testing: a change that shortens the file
 * throws somewhere in `applyEdits` by luck, and a test resting on that luck would
 * pass against code that has no check at all.
 */
describe('commit refuses a file that changed after the plan was checked', () => {
  const edited = (text: string): string => text.replace('const alt', 'const ALT');

  it('refuses before writing the manifest, leaving the tree untouched', async () => {
    const harness = memoryStore(tree());
    const original = projectFiles(harness.files);
    await prepare(plan(), harness.store, RUN_DIR);

    harness.files.set('src/App.jsx', edited(tree()['src/App.jsx'] as string));

    await expect(commit(plan(), harness.store, context())).rejects.toMatchObject({
      code: 'TRANSACTION_FOREIGN_CHANGE',
    });
    expect(harness.files.has(MANIFEST_PATH)).toBe(false);
    expect(projectFiles(harness.files)).toEqual({
      ...original,
      'src/App.jsx': edited(tree()['src/App.jsx'] as string),
    });
  });

  it('refuses mid-run without overwriting what the other writer put there', async () => {
    const harness = memoryStore(tree());
    const saved = edited(tree()['src/App.jsx'] as string);

    // Saved during the create phase, which is where the encoded images land, so this
    // stands in for the editor that writes while a run is copying bytes into place.
    const store: FileStore = {
      ...harness.store,
      async copy(from, to) {
        await harness.store.copy(from, to);
        harness.files.set('src/App.jsx', saved);
      },
    };

    await expect(commit(plan(), store, context())).rejects.toMatchObject({
      code: 'TRANSACTION_FOREIGN_CHANGE',
    });
    expect(harness.files.get('src/App.jsx')).toBe(saved);
    expect(harness.files.has(MANIFEST_PATH)).toBe(true);
  });
});

describe('revert', () => {
  it('restores a byte-identical tree after a complete run', async () => {
    const original = tree();
    const harness = memoryStore(original);
    const manifest = await commit(plan(), harness.store, context());

    expect(projectFiles(harness.files)).not.toEqual(
      projectFiles(new Map(Object.entries(original))),
    );

    await revert(manifest, harness.store);
    expect(projectFiles(harness.files)).toEqual(projectFiles(new Map(Object.entries(original))));
  });

  it('refuses to revert over a file somebody else changed', async () => {
    const harness = memoryStore(tree());
    const manifest = await commit(plan(), harness.store, context());
    harness.files.set('src/App.jsx', 'a person edited this after the run\n');

    await expect(revert(manifest, harness.store)).rejects.toBeInstanceOf(UpflyError);
    // Nothing else was rolled back either: a refusal must not leave a third state.
    expect(harness.files.get('src/logo.webp')).toBe('WEBP-BYTES');
  });

  it('is safe to run twice', async () => {
    const original = tree();
    const harness = memoryStore(original);
    const manifest = await commit(plan(), harness.store, context());

    await revert(manifest, harness.store);
    await revert(manifest, harness.store);
    expect(projectFiles(harness.files)).toEqual(projectFiles(new Map(Object.entries(original))));
  });
});

/**
 * A tree and a store over it, so a matrix can run against either implementation.
 *
 * The disk half is not thoroughness for its own sake. The in-memory double's `copy`
 * overwrites its destination and the real store refuses to, so any recovery path
 * that copies onto a file already present passes in memory and fails on a disk.
 * These matrices are the strongest instrument this project has and, until now, both
 * of them only ever ran against the double.
 */
interface MatrixHarness {
  readonly store: FileStore;
  /** The project's own files, with the run directory and the manifest left out. */
  projectFiles(): Promise<Record<string, string>>;
  /** The manifest as written, or undefined when the run never reached it. */
  manifest(): Promise<string | undefined>;
  mutations(): number;
  failAfter(count: number): void;
  stopFailing(): void;
  dispose(): Promise<void>;
}

interface MatrixStore {
  readonly name: string;
  open(): Promise<MatrixHarness>;
}

const inMemory: MatrixStore = {
  name: 'in memory',
  async open() {
    const files = new Map(Object.entries(tree()));
    const interrupted = interruptible(memoryFiles(files));

    return {
      ...interrupted,
      projectFiles: async () => projectFiles(files),
      manifest: async () => files.get(MANIFEST_PATH),
      dispose: async () => {},
    };
  },
};

const onDisk: MatrixStore = {
  name: 'on a real filesystem',
  async open() {
    // The OS temp directory rather than anywhere in the workspace: this tree has a
    // `public/` in it, and the v2 extension converts images inside in-repo ones in
    // place, which has already destroyed a set of fixture files once.
    const root = await mkdtemp(join(tmpdir(), 'upfly-matrix-'));

    for (const [path, text] of Object.entries(tree())) {
      const absolute = join(root, ...path.split('/'));
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, text, 'utf8');
    }
    const interrupted = interruptible(createNodeFileStore(root));

    return {
      ...interrupted,
      projectFiles: () => diskProjectFiles(root),
      manifest: async () => {
        try {
          return await readFile(join(root, ...MANIFEST_PATH.split('/')), 'utf8');
        } catch {
          return undefined;
        }
      },
      dispose: () => rm(root, { recursive: true, force: true }),
    };
  },
};

/** The view `projectFiles` gives of the in-memory map, taken from a real tree. */
async function diskProjectFiles(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};

  for (const name of (await readdir(root, { recursive: true })).sort()) {
    const relative = name.split(sep).join('/');
    if (relative.startsWith('.upfly/')) continue;
    const absolute = join(root, name);
    if (!(await stat(absolute)).isFile()) continue;
    out[relative] = await readFile(absolute, 'utf8');
  }
  return out;
}

/**
 * Well beyond what either store needs alone, because these do not run alone.
 *
 * The disk matrices take a couple of seconds by themselves and several times that
 * when the whole suite is running in parallel around them, which is the only way CI
 * ever runs them. A default timeout tuned to a quiet machine turns a real failure
 * and a busy one into the same red.
 */
const MATRIX_TIMEOUT_MS = 120_000;

describe.each([inMemory, onDisk])('the crash matrix, $name', (matrix) => {
  it(
    'restores a byte-identical tree after a failure at every step of commit',
    async () => {
      const reference = await matrix.open();
      const original = await reference.projectFiles();
      await commit(plan(), reference.store, context());
      const steps = reference.mutations();
      await reference.dispose();

      expect(steps).toBeGreaterThan(5);
      let treesActuallyChanged = 0;

      for (let failAfter = 0; failAfter < steps; failAfter++) {
        const harness = await matrix.open();
        harness.failAfter(failAfter);
        await expect(commit(plan(), harness.store, context())).rejects.toThrow(/injected failure/);

        const interrupted = await harness.manifest();
        if (interrupted === undefined) {
          // Only possible when the crash beat the manifest write, in which case the
          // tree cannot have been touched.
          expect(await harness.projectFiles()).toEqual(original);
          await harness.dispose();
          continue;
        }

        if (JSON.stringify(await harness.projectFiles()) !== JSON.stringify(original)) {
          treesActuallyChanged += 1;
        }

        harness.stopFailing();
        await revert(JSON.parse(interrupted), harness.store);
        expect(await harness.projectFiles(), `failure after mutation ${failAfter}`).toEqual(
          original,
        );
        await harness.dispose();
      }

      // Without this the matrix could pass by never having changed anything, which is
      // the vacuous version of the same test.
      expect(treesActuallyChanged).toBeGreaterThan(0);
    },
    MATRIX_TIMEOUT_MS,
  );

  it(
    'recovers when the undo is itself interrupted, from every state a commit can leave',
    async () => {
      const reference = await matrix.open();
      const original = await reference.projectFiles();
      await commit(plan(), reference.store, context());
      const commitSteps = reference.mutations();
      await reference.dispose();

      let undosActuallyInterrupted = 0;

      // The last value lets commit run to the end, so undo is exercised from the
      // completed run as well as from every point a crash can cut it short at. The
      // matrix that existed before this one interrupted commit only, and then reverted
      // on a disk that had started working again.
      for (let commitFailAfter = 0; commitFailAfter <= commitSteps; commitFailAfter++) {
        for (let undoFailAfter = 0; ; undoFailAfter++) {
          const harness = await matrix.open();
          harness.failAfter(commitFailAfter);
          const run = commit(plan(), harness.store, context());

          if (commitFailAfter < commitSteps) {
            await expect(run).rejects.toThrow(/injected failure/);
          } else {
            await run;
          }

          const afterCommit = await harness.manifest();
          if (afterCommit === undefined) {
            await harness.dispose();
            break;
          }

          harness.failAfter(undoFailAfter);
          let interrupted = false;
          try {
            await revert(JSON.parse(afterCommit), harness.store);
          } catch (cause) {
            if (!/injected failure/.test((cause as Error).message)) throw cause;
            interrupted = true;
            undosActuallyInterrupted += 1;
          }

          // What a person does next: read whatever manifest is on disk and undo again.
          harness.stopFailing();
          const remaining = await harness.manifest();
          expect(remaining).toBeDefined();
          await revert(JSON.parse(remaining as string), harness.store);

          expect(
            await harness.projectFiles(),
            `commit cut after ${commitFailAfter}, undo cut after ${undoFailAfter}`,
          ).toEqual(original);
          await harness.dispose();

          // One step past the last mutation the undo makes, so the loop stops at the
          // point where there was nothing left to interrupt.
          if (!interrupted) break;
        }
      }

      expect(undosActuallyInterrupted).toBeGreaterThan(0);
    },
    MATRIX_TIMEOUT_MS,
  );
});

describe('the manifest is deterministic except where it says it is not', () => {
  it('produces byte-identical manifests across two runs over identical input', async () => {
    const other = '.upfly/runs/a-different-run';
    const first = await commit(plan(), memoryStore(tree()).store, context());
    const second = await commit(plan(), memoryStore(tree(other)).store, {
      ...context(),
      runId: 'a-different-run',
      runDir: other,
    });

    expect(withoutVolatileFields(first)).toEqual(withoutVolatileFields(second));
  });

  it('fails when a field outside the allow-list varies', async () => {
    const manifest = await commit(plan(), memoryStore(tree()).store, context());
    const drifted = {
      ...manifest,
      declined: [{ path: 'other.png', line: 1, reason: 'different' }],
    };

    expect(withoutVolatileFields(manifest)).not.toEqual(withoutVolatileFields(drifted));
  });

  it('refuses an allow-list entry naming a field the manifest does not have', async () => {
    const manifest = await commit(plan(), memoryStore(tree()).store, context());
    const { startedAt: _renamedAway, ...renamed } = manifest;

    expect(() => withoutVolatileFields(renamed as never)).toThrow(/listed as volatile/);
  });

  it('names every volatile field', () => {
    expect([...MANIFEST_VOLATILE_FIELDS]).toEqual([
      'runId',
      'startedAt',
      'completedAt',
      'revertedAt',
      'runDir',
    ]);
  });
});

describe('inspect', () => {
  it('reports every operation as not-applied before a commit', async () => {
    const harness = memoryStore(tree());
    const manifest = await commit(plan(), memoryStore(tree()).store, context());

    const states = await inspect(manifest, harness.store);
    expect(states.map((state) => state.status)).toEqual([
      'not-applied',
      'not-applied',
      'not-applied',
      'not-applied',
    ]);
  });

  it('reports a move whose copy landed but whose source is still there as partial', async () => {
    const harness = memoryStore(tree());
    const manifest = await commit(plan(), memoryStore(tree()).store, context());
    await harness.store.copy('public/hero.png', 'public/images/hero.png');

    const states = await inspect(manifest, harness.store);
    const move = states.find((state) => state.operation.kind === 'move');
    expect(move?.status).toBe('partial');
  });
});

describe('the manifest names the function that made its hashes', () => {
  it('records the algorithm its store reported', async () => {
    const manifest = await commit(plan(), memoryStore(tree()).store, context());
    expect(manifest.hashAlgorithm).toBe('sha256');
  });

  it('refuses to check hashes made by a different function', async () => {
    // Comparing sha256 against something else would call every file foreign, which
    // is the most alarming thing this tool can say and would be entirely an artefact
    // of the mismatch.
    const harness = memoryStore(tree());
    const manifest = await commit(plan(), harness.store, context());
    const older = { ...manifest, hashAlgorithm: 'sha1' };

    await expect(inspect(older, harness.store)).rejects.toThrow(/none of them can be checked/);
    await expect(revert(older, harness.store)).rejects.toThrow(/none of them can be checked/);
  });
});

describe('a reverted manifest says so', () => {
  it('does not leave the manifest claiming the changes are live', async () => {
    const harness = memoryStore(tree());
    const manifest = await commit(plan(), harness.store, context());
    const reverted = await revert(manifest, harness.store, () => '2026-01-02T00:00:00.000Z');

    expect(reverted.state).toBe('reverted');
    expect(reverted.revertedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(JSON.parse(harness.files.get(MANIFEST_PATH) as string).state).toBe('reverted');
  });

  it('keeps the first undo time when run a second time', async () => {
    const harness = memoryStore(tree());
    const manifest = await commit(plan(), harness.store, context());

    const first = await revert(manifest, harness.store, () => '2026-01-02T00:00:00.000Z');
    const second = await revert(first, harness.store, () => '2026-01-03T00:00:00.000Z');

    // The second call reverts nothing, so stamping a new time would claim otherwise.
    expect(second.revertedAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('is distinguishable from an interrupted run', async () => {
    const harness = memoryStore(tree());
    const manifest = await commit(plan(), harness.store, context());
    const reverted = await revert(manifest, harness.store, () => '2026-01-02T00:00:00.000Z');

    // The distinction recovery needs: pending means finish cleaning up, reverted
    // means there is nothing left to do.
    expect(manifest.state).toBe('committed');
    expect(reverted.state).not.toBe('pending');
  });
});

describe('a declined item points at a place', () => {
  it('carries the line as well as the file', async () => {
    const manifest = await commit(plan(), memoryStore(tree()).store, context());
    const [declined] = manifest.declined;

    expect(declined?.path).toBe('src/data/logos.ts');
    expect(declined?.line).toBe(55);
  });
});

describe('the manifest schema is public API', () => {
  it('matches the approved shape', async () => {
    // Rule 6: a change to this snapshot is a schema change, and a schema change is
    // something a reviewer approves rather than something that lands because the
    // tests were updated alongside it.
    const manifest = await commit(plan(), memoryStore(tree()).store, context());
    expect(withoutVolatileFields(manifest)).toMatchSnapshot();
  });
});
