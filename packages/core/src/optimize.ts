/**
 * The wiring: a graph and its measurements in, a committed transaction out.
 *
 * Deliberately thin, and it carries no policy of its own. Every decision about what
 * converts, what is repointed and what is declined belongs to `plan.ts`, which is
 * pure; every decision about what is safe to write belongs to `transaction.ts`. If a
 * change here starts with `if` about whether to convert something, it is in the wrong
 * file, and the two-implementations-of-one-rule problem is the one this project keeps
 * paying for.
 *
 * The sequence is fixed: plan, stage, prepare, commit. The planner decides, staging
 * puts bytes where the transaction expects them, `prepare` checks the whole plan
 * against the tree while nothing has been touched, and `commit` writes in the order
 * that keeps every prefix of the run buildable.
 */

import { createHash } from 'node:crypto';
import type { AuditResult } from './audit.js';
import { applyEdits } from './edits.js';
import type { Graph } from './graph.js';
import { acquireLock } from './lock.js';
import type { Manifest } from './manifest.js';
import { type Survivor, findSurvivingPaths, spellingsFor } from './old-path-search.js';
import {
  type OptimizationPlan,
  type PlanRefusal,
  type PublicPolicy,
  type RootLinkPolicy,
  patternTargets,
  planOptimization,
} from './plan.js';
import type { AssetProbe, EncodeFormat, ImageProbe } from './probe.js';
import type { ServingRoots } from './resolve.js';
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
   * The graph the audit reported on, not one built separately.
   *
   * A second graph would let the plan act on a repository the user never saw a
   * report about, and the two could disagree without anything failing.
   */
  readonly graph: Graph;
  /**
   * The audit of that same graph, read only for its hedged assets.
   *
   * Taken as a result rather than recomputed: which assets are `possibly-dead` comes
   * out of the sweep and the per-asset hedging rule, and a second implementation of
   * that rule here is exactly the shape this codebase keeps being burned by. The
   * planner gets the set; it never gets the logic.
   */
  readonly audit: AuditResult;
  /** The measurements the audit used, so a saving is never quoted from a new number. */
  readonly probes: readonly AssetProbe[];
  /** The writing half of the port that produced `probes`. */
  readonly probe: ImageProbe;
  readonly store: FileStore;
  /**
   * Every file in the project, POSIX-relative — source *and* unscanned.
   *
   * 🔴 **R77's haystack, and it must come from the WALK rather than from the graph.**
   * The whole class of defect R77 guards against is a reference the graph never saw, and
   * a file holding only such a reference appears nowhere in `graph.references`. Deriving
   * this list from the graph would therefore miss exactly the files it exists to search
   * — measured on `scratch-www`, where `phone-input.jsx` holds
   * `flagsImagePath="/images/flags.png"` and nothing else the engine recognises.
   *
   * ⚠️ **Required, not optional, and `[]` is a real answer** — the same reasoning as
   * `MoveCheckInput.excludedRoots`. A caller that simply forgot it would get a silent
   * empty search and a confident delete, which is the failure this input exists to stop.
   */
  readonly files: readonly string[];
  readonly servingRoots: ServingRoots;
  readonly format: EncodeFormat;
  readonly publicDir: string;
  readonly publicPolicy: PublicPolicy;
  readonly rootLinkPolicy?: RootLinkPolicy;
  /** Nothing outside the run directory is written unless this is true (rule 8). */
  readonly apply: boolean;
  readonly runId: string;
  readonly now: () => string;
  /**
   * Test seams for R68's lock. Both default to the truth; omitting them is correct.
   *
   * Here rather than as positional arguments because an applied run passes them on to
   * `commit`, and two places that each had their own copy could disagree about which
   * process this is.
   */
  readonly lock?: LockPorts;
}

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

/**
 * Which assets have a literal mention of their path that this plan would NOT rewrite.
 *
 * 🔴 **R77.** `optimize --replace` deletes an original once its references have moved,
 * and *"its references"* means the ones the graph found. On `scratch-www` that left 67
 * occurrences of 12 deleted images standing — in custom JSX props (`flagsImagePath`,
 * `headerImgSrc`, `thumbnail`) and a config value (`og_image`) — while the run's own
 * before-and-after count reported no regression, because the same graph that missed them
 * did the counting. This looks for them in the text instead, before anything is written.
 *
 * ⚠️ **The occurrences the plan is ABOUT TO REWRITE are not survivors**, and at plan time
 * they all still read as the old path. They are excluded by position: an occurrence
 * inside a planned edit's range is one this run is going to fix. Without that exclusion
 * the check would refuse every conversion it looked at, which is the failure mode that
 * makes an over-cautious guard get deleted by the next person.
 *
 * ⚠️ **Only assets whose ORIGINAL WOULD BE DELETED are searched for.** Under
 * `keep-original` the source stays, an unrewritten mention still resolves, and refusing
 * would cost a saving to prevent nothing.
 *
 * 🔴 **What this bounds, stated because a bound nobody states is read as a guarantee:**
 * it catches a path **written down literally**. A path a program assembles at runtime —
 * `'/images/' + name + '.png'` — is not written down anywhere and matches nothing, so
 * this makes `replace` safe for the literal case and **no wider than that**.
 */
async function mentionsThatWouldSurvive(
  plan: OptimizationPlan,
  input: OptimizeInput,
): Promise<{ assets: ReadonlyMap<string, string>; occurrences: readonly Survivor[] }> {
  const deleting = plan.conversions.filter((conversion) => conversion.replacesOriginal);
  if (deleting.length === 0) return { assets: new Map(), occurrences: [] };

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

  // An occurrence names a spelling, not an asset, so map back through the spellings that
  // produced it. A spelling can belong to more than one asset only if two assets share a
  // path, which cannot happen.
  const assets = new Map<string, string>();
  for (const conversion of deleting) {
    const spellings = new Set(spellingsFor(conversion.asset, input.servingRoots.dirs));
    const mine = occurrences.filter((survivor) => spellings.has(survivor.spelling));
    const first = mine[0];
    if (first === undefined) continue;
    // One location plus a count, not the whole list: the reason has to stay one readable
    // sentence, and a user who opens the named file finds the rest by searching for the
    // same path.
    const more = mine.length === 1 ? '' : ` (and ${mine.length - 1} more)`;
    assets.set(conversion.asset, `${first.file}:${first.line}${more}`);
  }

  return { assets, occurrences };
}

/**
 * A run directory name: sortable, readable, and not derived from content.
 *
 * Two legitimate runs over an unchanged repository must not collide on a directory,
 * which is what a content hash would do, so the suffix is random rather than derived.
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
 * ⚠️ The reason this exists rather than handing `patternTargets` straight to the
 * probe: it returns absolute paths, the planner speaks in project-relative ones, and
 * the probe's cap is keyed on absolute. Those line up today by convention, and the
 * day either side changes convention every pattern would silently become undecidable,
 * because an exemption that matches nothing looks exactly like no exemption.
 *
 * So the lookup happens once, here, and it throws rather than returning a short list.
 * A target that names no asset means the two halves have drifted, which is a fault in
 * this engine and not in anybody's repository.
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
 * The assets to measure whatever the encode cap says.
 *
 * Exposed because the caller runs the probe: `optimize` must not take a second set of
 * measurements, or the saving it writes would come from different numbers than the
 * saving the audit reported.
 */
export function alwaysMeasureFor(graph: Graph): readonly Asset[] {
  return patternTargetAssets(graph);
}

export async function optimize(input: OptimizeInput): Promise<OptimizeResult> {
  const runDir = `.upfly/runs/${input.runId}`;

  const planWith = (blockedByMention?: ReadonlyMap<string, string>) =>
    planOptimization({
      graph: input.graph,
      probes: input.probes,
      format: input.format,
      publicDir: input.publicDir,
      publicPolicy: input.publicPolicy,
      hedged: hedgedAssets(input.audit),
      servingRoots: input.servingRoots,
      ...(blockedByMention === undefined ? {} : { blockedByMention }),
      ...(input.rootLinkPolicy === undefined ? {} : { rootLinkPolicy: input.rootLinkPolicy }),
    });

  const first = planWith();

  // 🔴 **R77, and it runs on a DRY RUN too — deliberately.** `OptimizeResult.plan` is
  // documented as *"every decision, identical on a dry run and an applied one"*, and a
  // guard that only fired on apply would make the preview a different set of decisions
  // from the run it previews. That is the one invariant this result has.
  //
  // Planned twice rather than filtered once: dropping a conversion also has to drop the
  // rewrites it caused, and those are interleaved per file with every other asset's.
  // The planner is pure and cheap, so asking it again with the blocked set is both
  // simpler and safer than unpicking its output.
  const blocked = await mentionsThatWouldSurvive(first, input);
  const plan = blocked.assets.size === 0 ? first : planWith(blocked.assets);

  if (plan.refusal !== null) {
    return { plan, runId: input.runId, runDir, manifest: null, refusal: plan.refusal };
  }

  // A dry run stops here, with every decision made and no byte written.
  //
  // It deliberately does not encode. B2's note had staging happen either way so that
  // a preview could not compute something different from what an applied run does,
  // and the decisions are what could differ: those are all above this line and are
  // identical. What is below is the same plan carried out. Encoding every image to
  // preview it would also make a dry run as slow as a real one, on a tool whose
  // default mode is the dry run.
  if (!input.apply) {
    return { plan, runId: input.runId, runDir, manifest: null, refusal: null };
  }

  const operations = await stage(plan, runDir, input);
  if (operations.length === 0) {
    return { plan, runId: input.runId, runDir, manifest: null, refusal: null };
  }

  // 🔴 R68, and the reason the lock is taken HERE and not only inside `commit`.
  // `commit` holds it across its own two manifest writes, which closes the failure as
  // ruled. It does not close the gap between staging and committing: a second run that
  // starts and finishes entirely inside that gap has its committed manifest overwritten
  // by this run's pending one the moment this run resumes, and its backups are orphaned
  // exactly as if it had been interrupted mid-write. Held from before `prepare` to
  // after `commit`, that window does not exist.
  //
  // The inner acquisition in `commit` re-enters on `runId` and its release is a no-op,
  // so the two holds nest rather than fight.
  const held = await acquireLock({
    store: input.store,
    runId: input.runId,
    now: input.now,
    ...input.lock,
  });

  try {
    return await applyUnderLock(plan, operations, runDir, input);
  } finally {
    await held.release();
  }
}

/** Everything an applied run does while it holds the lock. */
async function applyUnderLock(
  plan: OptimizationPlan,
  operations: readonly PlannedOperation[],
  runDir: string,
  input: OptimizeInput,
): Promise<OptimizeResult> {
  await prepare(operations, input.store, runDir);
  const context: RunContext = {
    runId: input.runId,
    runDir,
    now: input.now,
    // R66: both lists, because `Declined` in the manifest is *"something the run
    // chose not to do"* — action-scoped — and not removing an original is exactly
    // that. It is kept out of `plan.declined` only because the REPORT renders that
    // list under "Examined and not converted", which these assets were. The manifest
    // has no such heading to contradict, and it is the record that outlives the run,
    // so leaving the kept originals out of it would put the silence back where it
    // matters most.
    declined: [
      ...plan.declined,
      ...plan.keptOriginals.map((kept) => ({
        path: kept.asset,
        line: null,
        reason: kept.reason,
      })),
    ],
  };

  return {
    plan,
    runId: input.runId,
    runDir,
    manifest: await commit(operations, input.store, context, input.lock ?? {}),
    refusal: null,
  };
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
 * seeing. Asset paths are unique, so collisions are impossible.
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

    await input.probe.encodeToFile({
      path: source.asset.path,
      format: conversion.format,
      // Getting this wrong writes a one-frame GIF and reports a saving only
      // achievable by destroying the animation.
      animated: animated.has(conversion.asset),
      // 🔴 R131. The plan chose this setting because it MEASURED fewer bytes that way.
      // Writing at the probe's default quality instead would put a different file on
      // disk from the one whose saving the user was shown — the advertised number would
      // have been real and the delivered file would not match it.
      lossless: conversion.quality === 'lossless',
      destination: `${input.graph.root}/${runDir}/${staged}`,
    });

    const afterHash = await input.store.hash(`${runDir}/${staged}`);
    if (afterHash === null) {
      throw new Error(`the encode of ${conversion.asset} produced no file at ${staged}`);
    }
    operations.push({ kind: 'create', path: conversion.target, staged, afterHash });

    if (!conversion.replacesOriginal) continue;

    // Before `prepare`, which refuses a delete whose backup is not actually there.
    // The bytes of a removed original are the one thing the manifest cannot
    // reconstruct from anything else.
    const backup = `backup/${conversion.asset}`;
    await input.store.copy(conversion.asset, `${runDir}/${backup}`);
    const beforeHash = await input.store.hash(conversion.asset);
    if (beforeHash === null) {
      throw new Error(`${conversion.asset} vanished between planning and staging`);
    }
    operations.push({ kind: 'delete', path: conversion.asset, beforeHash, backup });
  }

  for (const rewrite of plan.rewrites) {
    const before = await input.store.readText(rewrite.file);
    operations.push({
      kind: 'edit',
      path: rewrite.file,
      beforeHash: hashText(before, input.store.hashAlgorithm),
      // A second pass over text already in memory. The alternative is storing the
      // edited text and handing it to commit, which would mean commit wrote bytes it
      // had not re-read the source for.
      afterHash: hashText(applyEdits(before, rewrite.edits), input.store.hashAlgorithm),
      edits: rewrite.edits,
    });
  }

  return operations;
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

/**
 * Hash text the way the store hashes a file.
 *
 * The algorithm comes from the store rather than from a constant here, so the hashes
 * this computes and the hashes the transaction verifies cannot be made by different
 * functions.
 */
function hashText(text: string, algorithm: string): string {
  return createHash(algorithm).update(text, 'utf8').digest('hex');
}
