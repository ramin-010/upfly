/**
 * The wiring: a graph and its measurements in, a committed transaction out. The order is
 * fixed: plan, stage, prepare, commit.
 *
 * It carries no policy of its own. What converts, what is repointed and what is declined
 * is decided in `plan.ts`, which is pure; what is safe to write is decided in
 * `transaction.ts`. A condition here about whether to convert something belongs in the
 * planner, so that each rule has one implementation.
 */

import type { AuditResult } from './audit.js';
import { applyEdits } from './edits.js';
import { UpflyError } from './errors.js';
import type { Graph } from './graph.js';
import { acquireLock } from './lock.js';
import { type Manifest, UPFLY_DIRECTORY, pathsTouched } from './manifest.js';
import {
  type Survivor,
  type Unsearchable,
  findSurvivingPaths,
  spellingsFor,
} from './old-path-search.js';
import { compareStrings } from './paths.js';
import {
  type OptimizationPlan,
  type PlanRefusal,
  type PlannedRewrite,
  type PublicPolicy,
  type RootLinkPolicy,
  patternTargets,
  planOptimization,
} from './plan.js';
import type { AssetProbe, EncodeFormat, ImageProbe } from './probe.js';
import type { AliasMap } from './resolve/aliases.js';
import type { ServingRoots } from './resolve/resolve.js';
import { hashText } from './scan/text-hash.js';
import {
  type FileStore,
  type LockPorts,
  type PlannedOperation,
  type RunContext,
  commit,
  prepare,
} from './transaction.js';
import type { Asset } from './types.js';

export interface OptimizeInput {
  /**
   * The graph the audit reported on, not one built separately. A second graph could
   * disagree with the report the user saw, and nothing would fail.
   */
  readonly graph: Graph;
  /**
   * The audit of that same graph, read only for its `possibly-dead` assets. Taken rather
   * than worked out again, so the rule that hedges an asset has one implementation.
   */
  readonly audit: AuditResult;
  /** The measurements the audit used, so a saving is never quoted from a new number. */
  readonly probes: readonly AssetProbe[];
  /** The writing half of the port that produced `probes`. */
  readonly probe: ImageProbe;
  readonly store: FileStore;
  /**
   * Every file in the project, POSIX-relative, scanned or not: the text searched for
   * mentions of an original the plan would delete.
   *
   * It has to come from the walk, not the graph. The search is for references the graph
   * never found, and a file holding only such a reference is not in the graph at all.
   * Required, and `[]` is a real answer: a caller that forgot it would get an empty search
   * and a confident delete.
   */
  readonly files: readonly string[];
  /**
   * What the walk could not read, so the search never saw it: a directory it could not
   * list. Any entry keeps every original the plan would delete, as a file the search
   * cannot open does, since a mention inside it cannot be ruled out. Required for the
   * reason `files` is: a caller that forgot it would delete over the gap.
   */
  readonly unread: readonly Unsearchable[];
  /**
   * The files in `files` that the run's ignore rules excluded. A mention in one keeps its
   * original all the same, and the decline says the run excluded the file. It changes
   * wording only: `files` stays the whole search, so a delete never depends on it.
   */
  readonly excludedFiles?: readonly string[];
  readonly servingRoots: ServingRoots;
  /** The aliases the resolver used. See `PlanInput.aliases`. */
  readonly aliases?: AliasMap;
  /**
   * Lists a directory, so the plan counts the files the walk did not index. See
   * `PlanInput.listDirectory`.
   */
  readonly listDirectory?: (absolutePath: string) => readonly string[];
  readonly format: EncodeFormat;
  readonly publicPolicy: PublicPolicy;
  readonly rootLinkPolicy?: RootLinkPolicy;
  /** False for a dry run, which plans and writes nothing. */
  readonly apply: boolean;
  readonly runId: string;
  readonly now: () => string;
  /**
   * Test seams for the project lock, defaulting to the real process id and liveness check,
   * so leaving this out is correct. The same value goes to `optimize`'s own hold and to the
   * one `commit` takes inside it, so the two agree on which process this is, which re-entry
   * needs.
   */
  readonly lock?: LockPorts;
  /** Called as each stage finishes, with what it counted, so a caller can show progress. */
  readonly onProgress?: (event: OptimizeProgress) => void;
  /**
   * Called on an applied run once the plan is final, before anything is written, and only
   * when the plan has something to write. Returning false stops the run there: nothing is
   * written, and the result carries the plan with no manifest, as a dry run's does.
   *
   * A caller uses it for checks that need the finished plan, such as whether a version
   * control system will accept every file the run is about to write.
   */
  readonly beforeWrite?: (plan: OptimizationPlan) => boolean | Promise<boolean>;
}

/** One stage of an `optimize` run finished. The numbers say what that stage counted. */
export type OptimizeProgress =
  /** The decisions are made: images to convert, and files whose references move. */
  | { readonly stage: 'planned'; readonly conversions: number; readonly rewrites: number }
  /** An applied run finished writing: project files created, rewritten or removed. */
  | { readonly stage: 'written'; readonly files: number };

/**
 * Written inside Upfly's folder on the first applied run, so that git never lists the
 * folder and the project's own `.gitignore` never has to mention it. An existing file is
 * left as it is.
 */
const FOLDER_GITIGNORE = `${UPFLY_DIRECTORY}/.gitignore`;

export interface OptimizeResult {
  /** Every decision, identical on a dry run and an applied one. */
  readonly plan: OptimizationPlan;
  readonly runId: string;
  /** POSIX-relative, and where staged bytes and backups live. */
  readonly runDir: string;
  /** Written only by an applied run that had something to do. */
  readonly manifest: Manifest | null;
  /** Set when the planner declined to act at all, and nothing was written. */
  readonly refusal: PlanRefusal | null;
}

/** What stops a delete: a mention the plan would not rewrite, or a gap in the search. */
interface Blocked {
  /** Each asset a surviving mention names, mapped to where it is (`file:line`). */
  readonly assets: ReadonlyMap<string, string>;
  /** Each asset only files the run excluded still name, mapped to where (`file:line`). */
  readonly excluded: ReadonlyMap<string, string>;
  /** Each asset the plan would delete, mapped to what could not be read. */
  readonly unread: ReadonlyMap<string, string>;
  readonly occurrences: readonly Survivor[];
}

/**
 * Which assets have a literal mention of their path that this plan would not rewrite.
 *
 * The planner already keeps any original that a reference the graph found still needs.
 * This searches the text for references the graph never found, such as a custom JSX prop
 * or a config value, before anything is written. A mention inside a range the plan
 * rewrites is not a survivor, or every conversion would be refused. Only originals the
 * plan deletes are searched: under `keep-original` a mention still resolves. A path built
 * at runtime (`'/images/' + name + '.png'`) is not written down, so it is never found.
 * See "The transaction" in ARCHITECTURE.md.
 */
async function mentionsThatWouldSurvive(
  plan: OptimizationPlan,
  input: OptimizeInput,
): Promise<Blocked> {
  const deleting = plan.conversions.filter((conversion) => conversion.replacesOriginal);
  if (deleting.length === 0) {
    return { assets: new Map(), excluded: new Map(), unread: new Map(), occurrences: [] };
  }

  // Every range this plan will rewrite, so an occurrence inside one can be discounted.
  const planned = new Map<string, [number, number][]>();
  for (const rewrite of plan.rewrites) {
    planned.set(
      rewrite.file,
      rewrite.edits.map((edit) => [edit.start, edit.end] as [number, number]),
    );
  }

  const found = await findSurvivingPaths({
    moves: deleting.map((conversion) => ({ from: conversion.asset, to: conversion.target })),
    files: input.files,
    readFile: (relative) => input.store.readText(relative),
    servingDirs: input.servingRoots.dirs,
  });

  const occurrences = found.survivors.filter((survivor) => {
    const ranges = planned.get(survivor.file);
    if (ranges === undefined) return true;
    return !ranges.some(([start, end]) => start <= survivor.offset && survivor.offset < end);
  });

  // An occurrence names a spelling, not an asset, so map back through each asset's
  // spellings. Two assets can share one (the suffix `img/hero.png`, or `/hero.png` under two
  // serving roots), and a mention of it then blocks both: a lost saving, never a lost file.
  const excludedFiles = new Set(input.excludedFiles ?? []);
  const assets = new Map<string, string>();
  const excluded = new Map<string, string>();
  for (const conversion of deleting) {
    const spellings = new Set(spellingsFor(conversion.asset, input.servingRoots.dirs));
    const mine = occurrences.filter((survivor) => spellings.has(survivor.spelling));
    // A mention in a file the run reads is the one to name. Where only excluded files name
    // the path, the exclusion is why the mention stays as written, and the reason says so.
    const read = mine.filter((survivor) => !excludedFiles.has(survivor.file));
    const [into, named] = read.length > 0 ? [assets, read] : [excluded, mine];
    const first = named[0];
    if (first === undefined) continue;
    // One location plus a count, so the reason stays one readable sentence. Searching for
    // the same path finds the rest.
    const more = named.length === 1 ? '' : ` (and ${named.length - 1} more)`;
    into.set(conversion.asset, `${first.file}:${first.line}${more}`);
  }

  // A file the search could not open, or a directory the walk could not list, may hold the
  // mention that matters, so every original the plan would delete stays.
  const gaps = [...input.unread, ...found.unsearchable].sort((a, b) =>
    compareStrings(a.file, b.file),
  );
  const unread = new Map<string, string>();
  const gap = gaps[0];
  if (gap !== undefined) {
    const more = gaps.length === 1 ? '' : ` (and ${gaps.length - 1} more)`;
    for (const conversion of deleting) unread.set(conversion.asset, `${gap.file}${more}`);
  }

  return { assets, excluded, unread, occurrences };
}

/**
 * A run directory name: sortable, readable, and not derived from content. The suffix is
 * random because two runs over an unchanged repository must not share a directory, as
 * they would if it were a content hash.
 */
export function newRunId(now: Date, random: () => number = Math.random): string {
  const stamp = now
    .toISOString()
    .replace(/[:-]/g, '')
    .replace(/\.\d+Z$/, '');
  const suffix = Math.floor(random() * 0xffff)
    .toString(16)
    .padStart(4, '0');
  return `${stamp}-${suffix}`;
}

/**
 * Assets a pattern reference could match, as objects rather than as paths.
 *
 * `patternTargets` returns absolute paths, the planner speaks in project-relative ones,
 * and the probe's cap is keyed on absolute ones. They line up by convention only, and an
 * exemption that matches nothing looks exactly like no exemption. So a target that names
 * no asset throws: the two sides have drifted, a fault in the engine, not the project.
 */
function patternTargetAssets(graph: Graph): readonly Asset[] {
  const byPath = new Map(graph.assets.map((node) => [node.asset.path, node.asset]));
  const targets = patternTargets(graph);

  return targets.map((path) => {
    const asset = byPath.get(path);
    if (asset === undefined) {
      throw new Error(
        `patternTargets named ${path}, which is not in the asset set. The resolver and the planner disagree about whether an asset path is absolute or project-relative.`,
      );
    }
    return asset;
  });
}

/**
 * Every asset a pattern reference could match, for a caller that measures them whatever the
 * encode cap says.
 */
export function alwaysMeasureFor(graph: Graph): readonly Asset[] {
  return patternTargetAssets(graph);
}

export async function optimize(input: OptimizeInput): Promise<OptimizeResult> {
  const runDir = `.upfly/runs/${input.runId}`;

  const planWith = (blocked?: Blocked) =>
    planOptimization({
      graph: input.graph,
      probes: input.probes,
      format: input.format,
      publicPolicy: input.publicPolicy,
      hedged: hedgedAssets(input.audit),
      servingRoots: input.servingRoots,
      ...(input.aliases === undefined ? {} : { aliases: input.aliases }),
      ...(input.listDirectory === undefined ? {} : { listDirectory: input.listDirectory }),
      ...(blocked === undefined
        ? {}
        : {
            blockedByMention: blocked.assets,
            blockedByExclusion: blocked.excluded,
            blockedByUnread: blocked.unread,
          }),
      ...(input.rootLinkPolicy === undefined ? {} : { rootLinkPolicy: input.rootLinkPolicy }),
    });

  const first = planWith();

  // Searched on a dry run too, or the preview would make different decisions from the run
  // it previews. Planned again rather than filtered: dropping a conversion also drops the
  // rewrites it caused, which share files with other assets' rewrites, and the planner is
  // pure and cheap.
  const blocked = await mentionsThatWouldSurvive(first, input);
  const nothingBlocked =
    blocked.assets.size === 0 && blocked.excluded.size === 0 && blocked.unread.size === 0;
  const plan = nothingBlocked ? first : planWith(blocked);

  if (plan.refusal !== null) {
    return { plan, runId: input.runId, runDir, manifest: null, refusal: plan.refusal };
  }
  input.onProgress?.({
    stage: 'planned',
    conversions: plan.conversions.length,
    rewrites: plan.rewrites.length,
  });

  // A dry run stops here, with every decision made and no byte written. It does not
  // encode: the decisions are all above this line, and encoding every image would make
  // the default mode as slow as an applied run.
  const unwritten: OptimizeResult = {
    plan,
    runId: input.runId,
    runDir,
    manifest: null,
    refusal: null,
  };
  if (!input.apply) return unwritten;
  if (plan.conversions.length === 0 && plan.rewrites.length === 0) return unwritten;
  if (input.beforeWrite !== undefined && !(await input.beforeWrite(plan))) return unwritten;

  await input.store.createExclusive(FOLDER_GITIGNORE, '*\n');
  const operations = await stage(plan, runDir, input);

  // Held from before `prepare` until after `commit`, not only inside `commit`: a run that
  // started and finished between the two would have its committed manifest replaced by
  // this run's pending one, leaving its backups with nothing pointing at them. `commit`
  // re-enters this hold, and releasing that inner hold does nothing.
  const held = await acquireLock({
    store: input.store,
    runId: input.runId,
    now: input.now,
    ...input.lock,
  });

  let manifest: Manifest;
  try {
    manifest = await applyUnderLock(plan, operations, runDir, input);
  } finally {
    await held.release();
  }
  input.onProgress?.({ stage: 'written', files: pathsTouched(manifest).length });
  return { plan, runId: input.runId, runDir, manifest, refusal: null };
}

/** Everything an applied run does while it holds the lock. */
async function applyUnderLock(
  plan: OptimizationPlan,
  operations: readonly PlannedOperation[],
  runDir: string,
  input: OptimizeInput,
): Promise<Manifest> {
  await prepare(operations, input.store, runDir);
  const context: RunContext = {
    runId: input.runId,
    runDir,
    now: input.now,
    // Both lists: a kept original is something the run chose not to do, which is what the
    // manifest's `declined` records, and the manifest outlives the run. The plan keeps them
    // apart only because the report shows `declined` under "Examined and not converted",
    // and these assets were converted.
    declined: [
      ...plan.declined,
      ...plan.keptOriginals.map((kept) => ({
        path: kept.asset,
        line: null,
        reason: kept.reason,
      })),
    ],
  };

  return commit(operations, input.store, context, input.lock ?? {});
}

/** The `possibly-dead` set, taken from the audit rather than worked out again. */
function hedgedAssets(audit: AuditResult): ReadonlySet<string> {
  const hedged = new Set<string>();
  for (const finding of audit.findings) {
    if (finding.kind === 'possibly-dead') hedged.add(finding.asset);
  }
  return hedged;
}

/**
 * Encode into the run directory and back up anything that will be removed, then
 * describe the whole thing as operations.
 *
 * Staged files mirror the project tree under `<runDir>/staged/` rather than being
 * named by a hash, so a person looking into a run directory recognises what they are
 * seeing. They cannot collide, because the planner declines every conversion whose target
 * another conversion shares.
 */
async function stage(
  plan: OptimizationPlan,
  runDir: string,
  input: OptimizeInput,
): Promise<PlannedOperation[]> {
  const operations: PlannedOperation[] = [];
  const animated = animatedAssets(input.probes);

  for (const conversion of plan.conversions) {
    const staged = `staged/${conversion.target}`;
    const source = input.graph.assets.find((node) => node.asset.relative === conversion.asset);
    if (source === undefined) {
      throw new Error(`the plan names ${conversion.asset}, which is not in the graph`);
    }

    // Hashed before the encode and checked after each step that reads the original, so the
    // file encoded, the file backed up and the file the delete expects are one file.
    const original = await input.store.hash(conversion.asset);
    if (original === null) {
      throw originalMoved(conversion.asset, 'was removed after Upfly read the project');
    }

    await unlessOriginalMoved(input.store, conversion.asset, original, () =>
      input.probe.encodeToFile({
        path: source.asset.path,
        format: conversion.format,
        // Getting this wrong keeps one frame of an animation, for a saving only
        // achievable by destroying it.
        animated: animated.has(conversion.asset),
        // The setting the saving was measured at. The probe's default quality would put a
        // different file on disk from the one whose saving the user was shown.
        lossless: conversion.quality === 'lossless',
        destination: `${input.graph.root}/${runDir}/${staged}`,
      }),
    );

    const afterHash = await input.store.hash(`${runDir}/${staged}`);
    if (afterHash === null) {
      throw new Error(`the encode of ${conversion.asset} produced no file at ${staged}`);
    }
    operations.push({ kind: 'create', path: conversion.target, staged, afterHash });

    if (!conversion.replacesOriginal) continue;

    // Before `prepare`, which refuses a delete whose backup is not actually there.
    const backup = `backup/${conversion.asset}`;
    await unlessOriginalMoved(input.store, conversion.asset, original, () =>
      input.store.copy(conversion.asset, `${runDir}/${backup}`),
    );
    operations.push({ kind: 'delete', path: conversion.asset, beforeHash: original, backup });
  }

  for (const rewrite of plan.rewrites) {
    const before = await input.store.readText(rewrite.file);
    // Read after every encode, which can take minutes, so this is the last moment to find
    // that the file was saved since the scan. Its edits' offsets count into the scanned
    // text: applied to any other, they would land in the wrong place, and every later check
    // would compare against this read and pass.
    refuseUnlessScannedText(rewrite, before);
    operations.push({
      kind: 'edit',
      path: rewrite.file,
      beforeHash: hashText(before, input.store.hashAlgorithm),
      // Applied here only to hash it. Handing the edited text to commit instead would
      // have commit write bytes without re-reading the source.
      afterHash: hashText(applyEdits(before, rewrite.edits), input.store.hashAlgorithm),
      edits: rewrite.edits,
    });
  }

  return operations;
}

/**
 * Run a step that reads an original, then refuse the run if the original is no longer the
 * file hashed before it, whether or not the step failed because of that. A failure with
 * the original unchanged is the step's own and is thrown as it is.
 *
 * @throws {UpflyError} `TRANSACTION_FOREIGN_CHANGE` when the original was removed or changed
 */
async function unlessOriginalMoved(
  store: FileStore,
  path: string,
  expected: string,
  step: () => Promise<unknown>,
): Promise<void> {
  let failure: { error: unknown } | null = null;
  try {
    await step();
  } catch (error) {
    failure = { error };
  }
  const now = await store.hash(path);
  if (now !== expected) {
    throw originalMoved(
      path,
      `${now === null ? 'was removed' : 'changed'} while Upfly was converting it`,
    );
  }
  if (failure !== null) throw failure.error;
}

/** The refusal for an original that is not the file the plan was made from. */
function originalMoved(path: string, happened: string): UpflyError {
  return new UpflyError(
    'TRANSACTION_FOREIGN_CHANGE',
    `${path} ${happened}, so no file in the project was changed. Run Upfly again to plan from the project as it is now.`,
  );
}

/**
 * Refuse a rewrite unless the file holds the text the scan read.
 *
 * @throws {UpflyError} `TRANSACTION_FOREIGN_CHANGE` when the file changed since the scan
 * @throws {UpflyError} `TRANSACTION_PLAN_INVALID` when the plan recorded no text to compare
 */
function refuseUnlessScannedText(rewrite: PlannedRewrite, text: string): void {
  if (rewrite.textHash === undefined) {
    throw new UpflyError(
      'TRANSACTION_PLAN_INVALID',
      `The plan has no record of the text ${rewrite.file} held when it was read, so its edits cannot be checked against the file, and nothing was written. Plan from a graph that runPipeline built.`,
    );
  }
  if (hashText(text) !== rewrite.textHash) {
    throw new UpflyError(
      'TRANSACTION_FOREIGN_CHANGE',
      `${rewrite.file} changed after Upfly read it, so its references are no longer where the plan found them, and no file in the project was changed. Run Upfly again to plan from the file as it is now.`,
    );
  }
}

/**
 * Which assets have more than one frame, from the measurements already taken.
 *
 * From the probe rather than from the extension: a `.gif` may well be a still, and a
 * `.webp` may not be.
 */
function animatedAssets(probes: readonly AssetProbe[]): ReadonlySet<string> {
  const animated = new Set<string>();
  for (const probe of probes) {
    if ((probe.metadata?.pages ?? 1) > 1) animated.add(probe.relative);
  }
  return animated;
}
