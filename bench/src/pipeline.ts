/**
 * The engine, wired end to end, once.
 *
 * There were two of these. `validate.ts` had its own copy for measuring findings and
 * `engine-run.ts` had another for driving `optimize`, and they had already diverged:
 * one detects serving roots and the other reads a hand-tuned list, one exempts pattern
 * targets from the encode cap and the other does not. The headline accuracy figure
 * comes out of the first and the write path out of the second, so the number this
 * project quotes and the engine it ships were describing different pipelines.
 *
 * What varies between callers is a parameter, not a fork. Nothing in here guesses: the
 * caller says where files are served from and whether to probe, because those are the
 * two decisions the two callers legitimately make differently.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import {
  type Adapter,
  type Asset,
  type AssetProbe,
  type AuditResult,
  type DiscoveryResult,
  type Graph,
  type ProbeOptions,
  type Reference,
  type ServingRoots,
  type SweepResult,
  audit,
  buildGraph,
  createSharpProbe,
  defaultAdapters,
  detectConventionRoots,
  discover,
  loadAliases,
  probeAssets,
  resolveReferences,
  scanSources,
  sweepForMentions,
} from 'upfly-core';

const ADAPTERS: readonly Adapter[] = defaultAdapters;

export interface PipelineInput {
  readonly root: string;
  /**
   * Where root-relative paths are served from, decided from the completed walk.
   *
   * A function rather than a value because one caller detects and the other reads a
   * hand-tuned list, and detection needs `discovery.directories` which does not exist
   * until the walk has run.
   */
  readonly servingRoots: (discovery: DiscoveryResult) => ServingRoots;
  /**
   * The directories the sweep and the audit treat as served.
   *
   * ⚠️ Separate from `servingRoots`, and only because `validate.ts` passes different
   * values to each on its unconfigured entries: the resolver gets the convention guess
   * while the sweep and the audit get an empty list. That is an inconsistency in the
   * harness rather than a design, it is preserved here so the extraction could be
   * proved byte-identical, and it is raised in STATE.md.
   */
  readonly publicDirs: (servingRoots: ServingRoots) => readonly string[];
  /**
   * Probe options for the completed graph, or null for `--no-probe`.
   *
   * A function of the graph for the same reason `servingRoots` is a function of the
   * walk: the set of assets a pattern reference could match is not knowable until the
   * graph exists, and R35 requires exactly those to escape the encode cap.
   *
   * Null rather than an empty object: `audit` reads the presence of `probes` as "was
   * probed", so an empty array would claim a measurement happened and report no
   * savings, which is the silent lie rather than the honest absence.
   */
  readonly probeOptions: (graph: Graph) => Omit<ProbeOptions, 'probe'> | null;
}

export interface PipelineOutput {
  readonly discovery: DiscoveryResult;
  readonly scanned: Awaited<ReturnType<typeof scanSources>>;
  readonly references: readonly Reference[];
  readonly graph: Graph;
  readonly servingRoots: ServingRoots;
  readonly audit: AuditResult;
  /** Returned because `buildReport` needs it and re-sweeping would read every file twice. */
  readonly sweep: SweepResult;
  /** Absent for a `--no-probe` run, which is what makes the report say so. */
  readonly probes: readonly AssetProbe[] | undefined;
  /** Milliseconds to build the graph, excluding the probe (the §3.4 budget). */
  readonly graphMs: number;
}

function basenamesOf(assets: readonly Asset[]): Set<string> {
  return new Set(assets.map((asset) => asset.relative.split('/').pop()?.toLowerCase() ?? ''));
}

export async function runPipeline(input: PipelineInput): Promise<PipelineOutput> {
  const readFileText = (path: string) => readFile(path, 'utf8');

  const started = performance.now();
  const discovery = await discover({ root: input.root, adapters: ADAPTERS });
  const scanned = await scanSources({
    sourceFiles: discovery.sourceFiles,
    adapters: ADAPTERS,
    readFile: readFileText,
    assetBasenames: basenamesOf(discovery.assets),
  });
  // The aliases the project declares, read from the files `discover` already found.
  // No second walk: a config file is an ordinary discovered file.
  const aliases = await loadAliases({
    root: discovery.root,
    files: [...discovery.sourceFiles, ...discovery.unscannedFiles],
    readFile: readFileText,
    exists: (path) => existsSync(path),
  });
  const servingRoots = input.servingRoots(discovery);
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
  const graphMs = Math.round(performance.now() - started);

  const publicDirs = input.publicDirs(servingRoots);
  const sweep = await sweepForMentions({
    graph,
    readFile: readFileText,
    // Haystack (c): only read if the cheaper two leave something unexplained.
    scannedMentions: scanned.mentions,
    publicDirs,
  });
  const probeOptions = input.probeOptions(graph);
  const probes =
    probeOptions === null
      ? undefined
      : await probeAssets(
          graph.assets.map((node) => node.asset),
          { probe: await createSharpProbe(), ...probeOptions },
        );
  // R17: the directories whose framework reads certain filenames without being told
  // to. Derived from the file list `discover` already produced, so `audit` stays off
  // the disk.
  const conventionRoots = detectConventionRoots([
    ...discovery.sourceFiles.map((file) => file.relative),
    ...discovery.unscannedFiles.map((file) => file.relative),
  ]);
  // Spread rather than `probes: probes`: under `exactOptionalPropertyTypes` an
  // explicit `undefined` is not an absent key, and `audit` reads the key's presence as
  // "was probed".
  const auditResult = await audit({
    graph,
    conventionRoots,
    sweep,
    readFile: readFileText,
    publicDirs,
    ...(probes === undefined ? {} : { probes }),
  });

  return {
    discovery,
    scanned,
    references,
    graph,
    servingRoots,
    audit: auditResult,
    sweep,
    probes,
    graphMs,
  };
}
