/**
 * The engine over one tree, and the applied run built on it.
 *
 * The pipeline itself lives in `pipeline.ts` and is shared with `validate.ts`. What is
 * here is the part specific to writing: detection rather than a hand-tuned list, no
 * encode cap, pattern targets exempted, and the refusal that keeps all of it away from
 * the pinned corpus.
 */

import { createHash } from 'node:crypto';
import {
  type AliasMap,
  type AssetProbe,
  type AuditResult,
  type Graph,
  type Manifest,
  type Move,
  type OptimizeResult,
  type PlannedOperation,
  type PublicPolicy,
  type RelocationPlan,
  type ServingRoots,
  applyEdits,
  commit,
  createNodeFileStore,
  createSharpProbe,
  detectServingRoots,
  newRunId,
  optimize,
  planRelocation,
  prepare,
} from 'upfly-core';
import { runPipeline } from './pipeline.js';
import { refuseValidationCorpus } from './repos.js';

export interface EngineRun {
  readonly graph: Graph;
  readonly audit: AuditResult;
  readonly servingRoots: ServingRoots;
  /** The measurements the audit used, so nothing downstream measures again. */
  readonly probes: readonly AssetProbe[];
  /** The alias map the resolver used, which `relocate` needs in order to invert it. */
  readonly aliases: AliasMap;
}

/**
 * Everything up to the plan: graph, measurements, findings.
 *
 * Serving roots come from detection rather than from a hand-written list, which is the
 * point: this is the path a first-time user takes, and until R50 the corpus had never
 * measured it.
 *
 * No encode cap, and pattern targets exempted from one anyway. A cap that limits what
 * we report is a convenience; a cap that limits what we can prove makes a pattern
 * permanently undecidable, and this is the path that writes.
 *
 * `declared` is for a project that states its serving root, which is what a real user
 * does once Upfly tells them to. Absent means detection, which is what a first run gets.
 */
export async function runEngine(root: string, declared?: ServingRoots): Promise<EngineRun> {
  const output = await runPipeline({
    root,
    servingRoots: (discovery) => declared ?? detectServingRoots(discovery.directories),
    publicDirs: (servingRoots) => servingRoots.dirs,
    probeOptions: { formats: ['webp'] },
  });

  return {
    graph: output.graph,
    audit: output.audit,
    servingRoots: output.servingRoots,
    probes: output.probes ?? [],
    aliases: output.aliases,
  };
}

/**
 * Run the engine over `root` and apply what it plans.
 *
 * The refusal is the first statement on purpose. This function converts images and
 * rewrites files under whatever path it is handed, and the pinned corpus is an
 * exported constant in this same package, so the distance between a correct call and
 * a catastrophic one is one argument.
 */
export async function optimizeTree(
  root: string,
  declared?: ServingRoots,
  publicPolicy: PublicPolicy = 'keep-original',
): Promise<OptimizeResult> {
  refuseValidationCorpus(root);

  const { graph, audit: findings, servingRoots, probes } = await runEngine(root, declared);

  return optimize({
    graph,
    audit: findings,
    probes,
    probe: await createSharpProbe(),
    store: createNodeFileStore(root),
    servingRoots,
    format: 'webp',
    publicDir: servingRoots.dirs[0] ?? 'public',
    publicPolicy,
    apply: true,
    runId: newRunId(new Date()),
    now: () => new Date().toISOString(),
  });
}

/**
 * Plan a set of moves over a real tree and carry them out.
 *
 * 🔴 **The instrument for the one question `relocate`'s tests cannot answer.** The
 * planner is proven against fixtures, and a fixture is a tree whose every reference the
 * graph finds — by construction, because we wrote it. **R39 is about the references the
 * graph MISSES**, and only a repository nobody designed for this engine has those. A
 * move acts on what the graph knows, so a reference it did not find becomes a dangling
 * reference **we caused** rather than one we found.
 *
 * ⚠️ `refuseValidationCorpus` first, exactly as `optimizeTree` does. Every measurement
 * in this project is stated against the pinned commits in `upfly-validation/`, and a
 * run that wrote inside one would invalidate all of them while the numbers still looked
 * plausible. The caller works on a copy; this makes that structural rather than
 * remembered (R52).
 */
export async function relocateTree(
  root: string,
  moves: readonly Move[],
): Promise<{ plan: RelocationPlan; manifest: Manifest | null }> {
  refuseValidationCorpus(root);

  const { graph, servingRoots, aliases } = await runEngine(root);
  const store = createNodeFileStore(root);

  const plan = planRelocation({
    graph,
    moves,
    servingRoots,
    publicDir: servingRoots.dirs[0] ?? null,
    aliases,
  });

  if (plan.moves.length === 0) return { plan, manifest: null };

  const runId = newRunId(new Date());
  const runDir = `.upfly/runs/${runId}`;
  const operations: PlannedOperation[] = [];

  for (const move of plan.moves) {
    const hash = await store.hash(move.from);
    if (hash === null) throw new Error(`${move.from} vanished between planning and staging`);
    operations.push({ kind: 'move', from: move.from, to: move.to, hash });
  }

  for (const rewrite of plan.rewrites) {
    const before = await store.readText(rewrite.file);
    operations.push({
      kind: 'edit',
      path: rewrite.file,
      beforeHash: hashText(before, store.hashAlgorithm),
      afterHash: hashText(applyEdits(before, rewrite.edits), store.hashAlgorithm),
      edits: rewrite.edits,
    });
  }

  await prepare(operations, store, runDir);
  const manifest = await commit(operations, store, {
    runId,
    runDir,
    now: () => new Date().toISOString(),
    // Rule 9: a reference the move could not follow is carried into the record that
    // outlives the run, not just printed once and lost.
    declined: plan.declined,
  });

  return { plan, manifest };
}

/** The same digest the store uses, so a manifest never names an algorithm twice. */
function hashText(text: string, algorithm: string): string {
  return createHash(algorithm).update(text, 'utf8').digest('hex');
}
