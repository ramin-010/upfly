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
import type { Manifest } from './manifest.js';
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
  readonly servingRoots: ServingRoots;
  readonly format: EncodeFormat;
  readonly publicDir: string;
  readonly publicPolicy: PublicPolicy;
  readonly rootLinkPolicy?: RootLinkPolicy;
  /** Nothing outside the run directory is written unless this is true (rule 8). */
  readonly apply: boolean;
  readonly runId: string;
  readonly now: () => string;
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

  const plan = planOptimization({
    graph: input.graph,
    probes: input.probes,
    format: input.format,
    publicDir: input.publicDir,
    publicPolicy: input.publicPolicy,
    hedged: hedgedAssets(input.audit),
    servingRoots: input.servingRoots,
    ...(input.rootLinkPolicy === undefined ? {} : { rootLinkPolicy: input.rootLinkPolicy }),
  });

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

  await prepare(operations, input.store, runDir);
  const context: RunContext = {
    runId: input.runId,
    runDir,
    now: input.now,
    declined: plan.declined,
  };

  return {
    plan,
    runId: input.runId,
    runDir,
    manifest: await commit(operations, input.store, context),
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
