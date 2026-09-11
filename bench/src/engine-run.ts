/**
 * The whole engine over one tree on disk, up to and including an applied run.
 *
 * Its own module because `validate.ts` ends in a top-level `await main()`, so nothing
 * can import a pipeline from there without running a full validation as a side
 * effect. A module that does something merely by being read is a landmine for the
 * first person who wants one value out of it.
 *
 * ⚠️ This is the second place in `bench/` that wires the engine end to end, and that
 * is a known duplication rather than an accepted one. `validate.ts` still has its own
 * copy; the two will drift. Recorded in STATE.md as owed work.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import {
  type Adapter,
  type Asset,
  type AssetProbe,
  type AuditResult,
  type Graph,
  type OptimizeResult,
  type ServingRoots,
  alwaysMeasureFor,
  audit,
  buildGraph,
  createNodeFileStore,
  createSharpProbe,
  defaultAdapters,
  detectConventionRoots,
  detectServingRoots,
  discover,
  loadAliases,
  newRunId,
  optimize,
  probeAssets,
  resolveReferences,
  scanSources,
  sweepForMentions,
} from 'upfly-core';

const ADAPTERS: readonly Adapter[] = defaultAdapters;

export interface EngineRun {
  readonly graph: Graph;
  readonly audit: AuditResult;
  readonly servingRoots: ServingRoots;
  /** The measurements the audit used, so nothing downstream measures again. */
  readonly probes: readonly AssetProbe[];
}

function basenamesOf(assets: readonly Asset[]): Set<string> {
  return new Set(assets.map((asset) => asset.relative.split('/').pop()?.toLowerCase() ?? ''));
}

/**
 * Everything up to the plan: graph, measurements, findings.
 *
 * Serving roots come from detection rather than from a hand-written list, which is
 * the point: this is the path a first-time user takes, and until R50 the corpus had
 * never measured it.
 */
export async function runEngine(root: string): Promise<EngineRun> {
  const readFileText = (path: string) => readFile(path, 'utf8');

  const discovery = await discover({ root, adapters: ADAPTERS });
  const scanned = await scanSources({
    sourceFiles: discovery.sourceFiles,
    adapters: ADAPTERS,
    readFile: readFileText,
    assetBasenames: basenamesOf(discovery.assets),
  });
  const aliases = await loadAliases({
    root: discovery.root,
    files: [...discovery.sourceFiles, ...discovery.unscannedFiles],
    readFile: readFileText,
    exists: (path) => existsSync(path),
  });
  const servingRoots = detectServingRoots(discovery.directories);
  const references = resolveReferences(scanned.references, {
    root: discovery.root,
    assets: discovery.assets,
    servingRoots,
    excludedRoots: discovery.excludedRoots,
    aliases,
    exists: (path) => existsSync(path),
  });
  const graph = buildGraph({
    root: discovery.root,
    assets: discovery.assets,
    references,
    unscannedFiles: [...discovery.unscannedFiles, ...scanned.unscanned],
  });

  const sweep = await sweepForMentions({
    graph,
    readFile: readFileText,
    scannedMentions: scanned.mentions,
    publicDirs: servingRoots.dirs,
  });
  // R35: every asset a pattern could match is measured whatever the cap says, or the
  // pattern is permanently undecidable rather than merely unreported.
  const probes = await probeAssets(
    graph.assets.map((node) => node.asset),
    {
      probe: await createSharpProbe(),
      formats: ['webp'],
      alwaysMeasure: alwaysMeasureFor(graph),
    },
  );
  const conventionRoots = detectConventionRoots([
    ...discovery.sourceFiles.map((file) => file.relative),
    ...discovery.unscannedFiles.map((file) => file.relative),
  ]);
  const findings = await audit({
    graph,
    sweep,
    probes,
    readFile: readFileText,
    publicDirs: servingRoots.dirs,
    conventionRoots,
  });

  return { graph, audit: findings, servingRoots, probes };
}

/** Run the engine over `root` and apply what it plans. */
export async function optimizeTree(root: string): Promise<OptimizeResult> {
  const { graph, audit: findings, servingRoots, probes } = await runEngine(root);

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
