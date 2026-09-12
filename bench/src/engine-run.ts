/**
 * The engine over one tree, and the applied run built on it.
 *
 * The pipeline itself lives in `pipeline.ts` and is shared with `validate.ts`. What is
 * here is the part specific to writing: detection rather than a hand-tuned list, no
 * encode cap, pattern targets exempted, and the refusal that keeps all of it away from
 * the pinned corpus.
 */

import {
  type AssetProbe,
  type AuditResult,
  type Graph,
  type OptimizeResult,
  type ServingRoots,
  createNodeFileStore,
  createSharpProbe,
  detectServingRoots,
  newRunId,
  optimize,
} from 'upfly-core';
import { runPipeline } from './pipeline.js';
import { refuseValidationCorpus } from './repos.js';

export interface EngineRun {
  readonly graph: Graph;
  readonly audit: AuditResult;
  readonly servingRoots: ServingRoots;
  /** The measurements the audit used, so nothing downstream measures again. */
  readonly probes: readonly AssetProbe[];
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
export async function optimizeTree(root: string, declared?: ServingRoots): Promise<OptimizeResult> {
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
    publicPolicy: 'keep-original',
    apply: true,
    runId: newRunId(new Date()),
    now: () => new Date().toISOString(),
  });
}
