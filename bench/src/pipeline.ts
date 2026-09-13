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

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import {
  type Adapter,
  type AliasMap,
  type Asset,
  type AssetProbe,
  type AuditResult,
  type DiscoveryResult,
  type Graph,
  type ProbeDiagnostic,
  type ProbeOptions,
  type Reference,
  type ScanDiagnostic,
  type ServingRoots,
  type SweepResult,
  alwaysMeasureFor,
  audit,
  buildGraph,
  createSharpProbe,
  defaultAdapters,
  detectConventionRoots,
  discover,
  hashCandidates,
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
   * Probe options, or null for `--no-probe`.
   *
   * ⚠️ A plain value rather than a function, and that is what makes `alwaysMeasure`
   * genuinely unavailable to a caller rather than merely discouraged. An object
   * literal passed here is checked for excess properties, so naming `alwaysMeasure`
   * is a compile error; the same type behind a function loses that freshness and the
   * property slips through silently, which was the first attempt at this fix.
   *
   * Null rather than an empty object: `audit` reads the presence of `probes` as "was
   * probed", so an empty array would claim a measurement happened and report no
   * savings, which is the silent lie rather than the honest absence.
   */
  readonly probeOptions: Omit<ProbeOptions, 'probe' | 'alwaysMeasure' | 'onDiagnostic'> | null;
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
  /**
   * What the imaging library said about the files it could not read.
   *
   * Collected here rather than left to each caller, for the same reason
   * `alwaysMeasure` is: a caller who forgets loses the information with no symptom.
   * It is kept out of the report on purpose, because libvips does not word the same
   * failure the same way twice and the report is promised to be byte-identical for
   * identical inputs. It belongs in a file beside the report, not in it.
   */
  readonly diagnostics: readonly ProbeDiagnostic[];
  /**
   * What PostCSS and Babel said, for the same reason and going to the same place.
   *
   * R60 was ruled on the imaging library and applies unchanged to the parsers: their
   * wording is theirs, it changes on a dependency upgrade, and the report carries our
   * classification instead. Measured on `railsgirls-com`, 23 `scan` skips used to
   * carry `<css input>:144:13: Unknown word /` verbatim.
   */
  readonly scanDiagnostics: readonly ScanDiagnostic[];
  /**
   * The aliases the resolver used, carried out so `relocate` can invert them.
   *
   * The graph does not record that a reference came through an alias, so a caller
   * planning a move needs the same map the resolver had or it will re-spell an aliased
   * import as though it were relative (R70).
   */
  readonly aliases: AliasMap;
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
  const scanDiagnostics: ScanDiagnostic[] = [];
  const scanned = await scanSources({
    sourceFiles: discovery.sourceFiles,
    adapters: ADAPTERS,
    readFile: readFileText,
    assetBasenames: basenamesOf(discovery.assets),
    onDiagnostic: (entry) => scanDiagnostics.push(entry),
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
  const diagnostics: ProbeDiagnostic[] = [];
  const probes =
    input.probeOptions === null
      ? undefined
      : await probeAssets(
          graph.assets.map((node) => node.asset),
          {
            probe: await createSharpProbe(),
            ...input.probeOptions,
            // R35, and deliberately not the caller's decision, which is why the type
            // above forbids passing it. Every asset a pattern reference could match is
            // measured whatever the cap says: an unmeasured target does not cost detail,
            // it makes the pattern permanently undecidable. A caller who forgot lost that
            // guarantee with no symptom at all, and validate.ts forgetting it for four
            // days is the proof that documenting it does not work.
            alwaysMeasure: alwaysMeasureFor(graph),
            onDiagnostic: (entry) => diagnostics.push(entry),
          },
        );
  // R17: the directories whose framework reads certain filenames without being told
  // to. Derived from the file list `discover` already produced, so `audit` stays off
  // the disk.
  const conventionRoots = detectConventionRoots([
    ...discovery.sourceFiles.map((file) => file.relative),
    ...discovery.unscannedFiles.map((file) => file.relative),
  ]);
  // §1.1's `duplicate`. Only assets whose size another asset shares are opened: two
  // byte-identical files must be the same size, so a unique size rules a file out
  // without reading it. On `railsgirls-com` that is the difference between hashing
  // 5,370 images and hashing a few hundred.
  const contentHashes = new Map<string, string>();
  for (const candidate of hashCandidates(discovery.assets)) {
    contentHashes.set(
      candidate.relative,
      createHash('sha256')
        .update(await readFile(candidate.path))
        .digest('hex'),
    );
  }

  // Spread rather than `probes: probes`: under `exactOptionalPropertyTypes` an
  // explicit `undefined` is not an absent key, and `audit` reads the key's presence as
  // "was probed".
  const auditResult = await audit({
    contentHashes,
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
    diagnostics,
    scanDiagnostics,
    aliases,
    graphMs,
  };
}
