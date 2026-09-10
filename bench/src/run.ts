/**
 * Measure the engine, so that every performance claim is a number this produced.
 *
 * Rule 16: a claim in the README is only ever a number `bench/` measured in CI. This
 * file owes four of them, three of which the build plan currently *assumes*:
 *
 * 1. **The graph budget** — discovery, scanning, resolution and linking on a
 *    10 000-file / 2 000-image tree, which §3.4 puts at under 3 s cold.
 * 2. **The encode-cap default**, which R11 deliberately left to be measured rather
 *    than guessed.
 * 3. **The probe concurrency default**, which §3.4 assumes is `os.cpus() - 1`. That
 *    was an assumption: libvips already multithreads inside a single encode, so the
 *    pool multiplies an already-parallel workload and the right number is not
 *    obvious from the core count.
 * 4. **The sweep**, which the R8 ruling requires be measured. It is bounded — only
 *    zero-reference assets, only unread files — but "bounded" is not a number.
 *
 * Probing and encoding are reported **separately** from the graph budget and never
 * folded into it: they are dominated by libvips, and tuning our code against
 * somebody else's decode time would be measuring the wrong thing.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { cpus, platform } from 'node:os';
import { argv, exit, stdout } from 'node:process';
import {
  type Adapter,
  type Asset,
  audit,
  buildGraph,
  buildReport,
  createSharpProbe,
  cssAdapter,
  discover,
  htmlAdapter,
  javascriptAdapter,
  jsonAdapter,
  markdownAdapter,
  probeAssets,
  resolveReferences,
  scanSources,
  sweepForMentions,
} from 'upfly-core';
import { TOTAL_FILES, TOTAL_IMAGES, generateTree } from './generate.js';

const ADAPTERS: readonly Adapter[] = [
  cssAdapter,
  htmlAdapter,
  javascriptAdapter,
  markdownAdapter,
  jsonAdapter,
];

interface Timing {
  readonly label: string;
  readonly ms: number;
}

/** Everything one run measured. Serialised verbatim by `--json`. */
interface BenchResult {
  readonly tree: { readonly files: number; readonly images: number; readonly root: string };
  readonly graphBudget: {
    readonly totalMs: number;
    readonly budgetMs: number;
    readonly withinBudget: boolean;
    readonly steps: readonly Timing[];
  };
  readonly sweep: {
    readonly ms: number;
    readonly candidates: number;
    readonly unreadFiles: number;
    readonly mentionsFound: number;
  };
  readonly probe: {
    readonly headersOnlyMs: number;
    readonly headersPerAssetMs: number;
    readonly encodeSamples: readonly { cap: number; ms: number; msPerAsset: number }[];
    readonly concurrencySamples: readonly { concurrency: number; ms: number }[];
  };
  readonly downstream: readonly Timing[];
  readonly graph: {
    readonly assets: number;
    readonly references: number;
    readonly unscannedFiles: number;
  };
  readonly machine: {
    readonly cpus: number;
    readonly platform: string;
    /** libuv's threadpool bounds `fs` reads, and defaults to 4 whatever the core count. */
    readonly uvThreadpoolSize: string;
  };
}

/** Time one step. Returns both the value and how long it took. */
async function timed<T>(label: string, work: () => Promise<T> | T): Promise<[T, Timing]> {
  const started = performance.now();
  const value = await work();
  return [value, { label, ms: Math.round(performance.now() - started) }];
}

async function main(): Promise<void> {
  const fresh = argv.includes('--fresh');
  const json = argv.includes('--json');
  // The graph budget is the number CI watches on every push; the probe numbers cost
  // minutes and are wanted far less often.
  const graphOnly = argv.includes('--graph-only');

  const [tree, generation] = await timed('generate tree', () => generateTree({ fresh }));
  const readFileText = (path: string) => readFile(path, 'utf8');

  // --- 1. The graph budget: everything up to and including linking. -------------
  const [discovery, discoverMs] = await timed('discover', () =>
    discover({ root: tree.root, adapters: ADAPTERS }),
  );
  const [scanned, scanMs] = await timed('scan', () =>
    scanSources({
      sourceFiles: discovery.sourceFiles,
      adapters: ADAPTERS,
      readFile: readFileText,
    }),
  );
  const [references, resolveMs] = await timed('resolve', () =>
    resolveReferences(scanned.references, {
      root: discovery.root,
      assets: discovery.assets,
      publicDir: 'public',
      excludedRoots: discovery.excludedRoots,
      exists: (path) => existsSync(path),
    }),
  );
  const [graph, graphMs] = await timed('graph', () =>
    buildGraph({
      root: discovery.root,
      assets: discovery.assets,
      references,
      unscannedFiles: [...discovery.unscannedFiles, ...scanned.unscanned],
    }),
  );

  const graphBudgetMs = discoverMs.ms + scanMs.ms + resolveMs.ms + graphMs.ms;

  // --- 2. The sweep, which R8 requires be measured. ------------------------------
  const [sweep, sweepMs] = await timed('sweep', () =>
    sweepForMentions({ graph, readFile: readFileText }),
  );

  // --- 3. Probing: headers for everything, then encodes. -------------------------
  const probe = await createSharpProbe();
  const assets = graph.assets.map((node) => node.asset);

  const [, metadataMs] = graphOnly
    ? [null, { label: 'probe: headers only', ms: 0 }]
    : await timed('probe: headers only', () => probeAssets(assets, { probe, formats: [] }));

  const encodeSamples = graphOnly ? [] : await measureEncodeCost(assets, probe);
  const concurrencySamples = graphOnly ? [] : await measureConcurrency(assets, probe);

  // --- 4. A full audit + report, so the end-to-end cost is on record. ------------
  const cappedProbes = graphOnly
    ? []
    : await probeAssets(assets, { probe, formats: ['webp'], maxEncodedAssets: 200 });
  const [auditResult, auditMs] = await timed('audit', () =>
    audit({ graph, sweep, readFile: readFileText, publicDir: 'public', probes: cappedProbes }),
  );
  const [, reportMs] = await timed('report', () =>
    buildReport({ graph, audit: auditResult, discovery, sweep, probes: cappedProbes }),
  );

  const result: BenchResult = {
    tree: { files: TOTAL_FILES, images: TOTAL_IMAGES, root: '<temp>' },
    graphBudget: {
      totalMs: graphBudgetMs,
      budgetMs: 3_000,
      withinBudget: graphBudgetMs < 3_000,
      steps: [discoverMs, scanMs, resolveMs, graphMs],
    },
    sweep: {
      ms: sweepMs.ms,
      candidates: graph.assets.filter((node) => node.references.length === 0).length,
      unreadFiles: graph.unscannedFiles.length,
      mentionsFound: sweep.mentions.size,
    },
    probe: {
      headersOnlyMs: metadataMs.ms,
      headersPerAssetMs: round(metadataMs.ms / Math.max(1, assets.length), 3),
      encodeSamples,
      concurrencySamples,
    },
    downstream: [auditMs, reportMs],
    graph: {
      assets: graph.assets.length,
      references: graph.references.length,
      unscannedFiles: graph.unscannedFiles.length,
    },
    machine: {
      cpus: cpus().length,
      platform: platform(),
      uvThreadpoolSize: process.env.UV_THREADPOOL_SIZE ?? '4 (default)',
    },
  };

  stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : render(result, generation));
  if (!result.graphBudget.withinBudget && argv.includes('--assert')) exit(1);
}

/**
 * What one encode costs, at a few cap sizes.
 *
 * The cap default falls out of this: pick the count whose wall-clock a person will
 * sit through. Measured at the real size mix rather than an average, because the
 * cap takes the **largest first** and those are the expensive ones — an average
 * would understate the cost of the assets the cap actually selects.
 */
async function measureEncodeCost(
  assets: readonly Asset[],
  probe: Awaited<ReturnType<typeof createSharpProbe>>,
): Promise<{ cap: number; ms: number; msPerAsset: number }[]> {
  const samples: { cap: number; ms: number; msPerAsset: number }[] = [];

  for (const cap of [50, 200, 500]) {
    const [, timing] = await timed(`encode ${cap}`, () =>
      probeAssets(assets, { probe, formats: ['webp'], maxEncodedAssets: cap }),
    );
    samples.push({ cap, ms: timing.ms, msPerAsset: round(timing.ms / cap, 1) });
  }

  return samples;
}

/**
 * Whether our pool helps, and where it stops helping.
 *
 * §3.4 assumes `os.cpus() - 1`. libvips already uses every core inside one encode,
 * so this pool multiplies an already-parallel workload and the answer is an
 * empirical question rather than an arithmetic one.
 */
async function measureConcurrency(
  assets: readonly Asset[],
  probe: Awaited<ReturnType<typeof createSharpProbe>>,
): Promise<{ concurrency: number; ms: number }[]> {
  const samples: { concurrency: number; ms: number }[] = [];
  const cores = cpus().length;

  for (const concurrency of unique([1, 2, 4, 8, Math.max(1, cores - 1)])) {
    const [, timing] = await timed(`concurrency ${concurrency}`, () =>
      probeAssets(assets, { probe, formats: ['webp'], maxEncodedAssets: 100, concurrency }),
    );
    samples.push({ concurrency, ms: timing.ms });
  }

  return samples;
}

function unique(values: readonly number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** Plain text, no locale formatting — the same rule the report renderer follows. */
function render(result: BenchResult, generation: Timing): string {
  const lines: string[] = [
    'upfly-core bench',
    '',
    `  tree: ${result.tree.files} files, ${result.tree.images} images (generated in ${generation.ms} ms)`,
    `  machine: ${result.machine.platform}, ${result.machine.cpus} logical cores, UV_THREADPOOL_SIZE=${result.machine.uvThreadpoolSize}`,
    '',
    `Graph budget — ${result.graphBudget.totalMs} ms of ${result.graphBudget.budgetMs} ms  ${result.graphBudget.withinBudget ? 'OK' : 'OVER'}`,
    '',
  ];

  for (const step of result.graphBudget.steps) lines.push(`  ${pad(step.label)} ${step.ms} ms`);
  lines.push('');

  lines.push('Sweep (excluded from the budget)', '');
  lines.push(`  ${pad('sweep')} ${result.sweep.ms} ms`);
  lines.push(
    `  ${result.sweep.candidates} zero-reference assets against ${result.sweep.unreadFiles} unread files — ${result.sweep.mentionsFound} rescued`,
    '',
  );

  lines.push('Probe (excluded from the budget)', '');
  lines.push(
    `  ${pad('headers, all assets')} ${result.probe.headersOnlyMs} ms  (${result.probe.headersPerAssetMs} ms each)`,
  );
  for (const sample of result.probe.encodeSamples) {
    lines.push(
      `  ${pad(`encode ${sample.cap} largest`)} ${sample.ms} ms  (${sample.msPerAsset} ms each)`,
    );
  }
  lines.push('');

  lines.push('Probe concurrency — 100 encodes', '');
  for (const sample of result.probe.concurrencySamples) {
    lines.push(`  ${pad(`concurrency ${sample.concurrency}`)} ${sample.ms} ms`);
  }
  lines.push('');

  lines.push('Downstream', '');
  for (const step of result.downstream) lines.push(`  ${pad(step.label)} ${step.ms} ms`);
  lines.push('');

  return lines.join('\n');
}

function pad(label: string): string {
  return `${label}:`.padEnd(24);
}

await main();
