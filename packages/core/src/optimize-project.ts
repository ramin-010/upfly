/**
 * `optimize` over a project on disk: the pipeline with every image measured, then the plan
 * and, when asked, the write. The CLI and the benchmark package's fixture builds both run
 * this, so what those builds prove is what users run.
 */

import { createNodeFileStore } from './file-store-node.js';
import {
  type OptimizeInput,
  type OptimizeProgress,
  type OptimizeResult,
  newRunId,
  optimize,
} from './optimize.js';
import {
  type PipelineOutput,
  type PipelineProgress,
  runPipeline,
  servingRootsFor,
} from './pipeline.js';
import type { PublicPolicy } from './plan.js';
import { createSharpProbe } from './probe-sharp.js';
import type { EncodeFormat } from './probe.js';
import type { ServingRoots } from './resolve.js';
import type { LockPorts } from './transaction.js';

export interface OptimizeProjectInput {
  /** The project directory. */
  readonly root: string;
  /** The folders the project says it is served from. Absent, Upfly decides them. */
  readonly declared?: ServingRoots;
  readonly format: EncodeFormat;
  readonly publicPolicy: PublicPolicy;
  /** Nothing is written unless this is true. */
  readonly apply: boolean;
  /** More paths to leave out, in `.gitignore` syntax, on top of `.upflyignore`. */
  readonly extraIgnores?: readonly string[];
  /** Called as each stage finishes: the pipeline's stages, then the plan's and the write's. */
  readonly onProgress?: (event: PipelineProgress | OptimizeProgress) => void;
  /** See `OptimizeInput.beforeWrite`. */
  readonly beforeWrite?: OptimizeInput['beforeWrite'];
  /** The run's id. A fresh one from the clock when absent. */
  readonly runId?: string;
  /** The clock the manifest's times come from. */
  readonly now?: () => string;
  readonly lock?: LockPorts;
}

export interface OptimizeProjectResult {
  /** What the plan was made from: the graph, audit and measurements a report is built on. */
  readonly pipeline: PipelineOutput;
  readonly optimize: OptimizeResult;
}

/**
 * Plans the optimization of the project at `root` and, when `apply` is true, carries it out.
 *
 * Every image is measured, with no cap: an image converts only on a measured saving, so a
 * cap would leave every image past it unconverted.
 *
 * @param input the project, the format and policy, and whether to write
 * @returns the pipeline's output and the run's result, whose plan is the same on a dry run
 * @throws {UpflyError} `TRANSACTION_LOCKED` when another run holds the project, and the
 * transaction's other codes when the tree changed under the run
 */
export async function optimizeProject(input: OptimizeProjectInput): Promise<OptimizeProjectResult> {
  const pipeline = await runPipeline({
    root: input.root,
    servingRoots: servingRootsFor(input.declared),
    publicDirs: (servingRoots) => servingRoots.dirs,
    probeOptions: { formats: [input.format] },
    ...(input.extraIgnores === undefined ? {} : { extraIgnores: input.extraIgnores }),
    ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
  });
  const { discovery } = pipeline;

  const result = await optimize({
    graph: pipeline.graph,
    audit: pipeline.audit,
    probes: pipeline.probes ?? [],
    probe: await createSharpProbe(),
    store: createNodeFileStore(discovery.root),
    // Every file the walk found, not only those the graph holds a reference in: the search
    // for leftover mentions of a deleted original is for references the graph missed.
    files: [...discovery.sourceFiles, ...discovery.unscannedFiles].map((file) => file.relative),
    servingRoots: pipeline.servingRoots,
    format: input.format,
    publicPolicy: input.publicPolicy,
    apply: input.apply,
    runId: input.runId ?? newRunId(new Date()),
    now: input.now ?? (() => new Date().toISOString()),
    ...(input.lock === undefined ? {} : { lock: input.lock }),
    ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
    ...(input.beforeWrite === undefined ? {} : { beforeWrite: input.beforeWrite }),
  });
  return { pipeline, optimize: result };
}
