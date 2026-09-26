/**
 * Measure the engine, so that every performance claim in the README is a number this
 * produced in CI.
 *
 * It times the graph budget (discovery, scanning, resolution and linking on a 10,000-file,
 * 2,000-image tree), the sweep, and the probe: headers, encodes at a few cap sizes, and the
 * probe's concurrency. Probing and encoding are reported apart from the graph budget:
 * libvips dominates them, and tuning our code against its decode time would measure the
 * wrong thing. See "Performance budget" in ARCHITECTURE.md.
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
  defaultAdapters,
  discover,
  probeAssets,
  resolveReferences,
  scanSources,
  sweepForMentions,
} from 'upfly-core';
import {
  type Breakdown,
  VARIANTS,
  type Variant,
  measureBreakdown,
  renderBreakdown,
  renderExperiment,
  sampleBreakdowns,
} from './breakdown.js';
import { TOTAL_FILES, TOTAL_IMAGES, generateTree } from './generate.js';
import {
  type InvocationSample,
  MEASURED_BETWEEN_RUN_DRIFT,
  sampleAcrossInvocations,
} from './invocations.js';

/**
 * The design target: what the graph build is supposed to cost.
 *
 * It is not what CI gates on. A ceiling loose enough not to fail on noise sits far above
 * it, so both are printed on every run, and a passing build is not read as a met target.
 */
const DESIGN_TARGET_MS = 3_000;

/**
 * The per-platform regression ceiling: the headline must not be slower than this.
 *
 * About 30% above the slowest of three CI runs on each platform (4,165 ms on Linux and
 * 5,641 ms on Windows). The headline drifts by up to about 22% between runs of unchanged
 * code, and a ceiling inside that range flips its verdict on the same commit. It catches
 * a regression above about 30% and cannot see a 10% one, which needs an A/B run back to
 * back in one session with `noise.ts`. See "The gate is a regression ceiling, not the
 * target" in ARCHITECTURE.md.
 *
 * `UPFLY_BENCH_BUDGET_MS` overrides it, which is how CI pins it per platform.
 */
const BUDGET_MS = Number(
  process.env.UPFLY_BENCH_BUDGET_MS ?? (process.platform === 'win32' ? 7_500 : 5_500),
);

const ADAPTERS: readonly Adapter[] = defaultAdapters;

interface Timing {
  readonly label: string;
  readonly ms: number;
}

/**
 * A measurement taken more than once.
 *
 * A single run is not a number to quote: on identical input, the graph budget can take
 * twice as long in one run as in the next.
 */
interface Sample {
  readonly label: string;
  /** The number to quote and gate against. Not the mean: one outlier moves a mean. */
  readonly medianMs: number;
  readonly minMs: number;
  readonly maxMs: number;
  /** `(max - min) / median`, as a percentage. Above ~20% something is wrong. */
  readonly spreadPercent: number;
  readonly runs: number;
  /** Every sample, so a reader can see the shape rather than trust the summary. */
  readonly allMs: readonly number[];
  /** These samples agreed with each other, which does not mean another run will repeat them. */
  readonly samplesAgree: boolean;
}

/** Above this, the samples disagree too much to quote a number from them. */
const MAX_SPREAD_PERCENT = 20;

/**
 * Run `work` repeatedly and summarise it.
 *
 * The first pass is discarded. A read-dominated workload is dominated by the filesystem
 * cache, so the first run measures a cold cache and the rest measure a warm one, and
 * averaging them together measures neither.
 */
async function sample<T>(
  label: string,
  runs: number,
  work: () => Promise<T> | T,
): Promise<[T, Sample]> {
  await work(); // warm-up, discarded

  const times: number[] = [];
  let last: T | undefined;
  for (let index = 0; index < runs; index++) {
    const started = performance.now();
    last = await work();
    times.push(performance.now() - started);
  }

  const sorted = [...times].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const medianMs =
    sorted.length % 2 === 0
      ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
      : (sorted[middle] ?? 0);
  const minMs = sorted[0] ?? 0;
  const maxMs = sorted[sorted.length - 1] ?? 0;
  const spreadPercent = medianMs === 0 ? 0 : ((maxMs - minMs) / medianMs) * 100;

  return [
    last as T,
    {
      label,
      medianMs: Math.round(medianMs),
      minMs: Math.round(minMs),
      maxMs: Math.round(maxMs),
      spreadPercent: Math.round(spreadPercent),
      runs,
      allMs: times.map((value) => Math.round(value)),
      // Marked unusable rather than averaged away: a number nobody can reproduce
      // should not be quoted, and hiding the disagreement inside a mean is how it
      // gets quoted anyway.
      samplesAgree: spreadPercent <= MAX_SPREAD_PERCENT,
    },
  ];
}

/** Everything one run measured. Serialised verbatim by `--json`. */
interface BenchResult {
  readonly tree: { readonly files: number; readonly images: number; readonly root: string };
  readonly graphBudget: {
    /** The median of the sampled runs. The only figure that may be quoted. */
    readonly totalMs: number;
    /** The single-pass breakdown's total, for comparison with the median. */
    readonly stepTotalMs: number;
    readonly budgetMs: number;
    /** False when over budget, or when the samples disagreed too much to say. */
    readonly withinBudget: boolean;
    readonly sample: Sample;
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

/** Lowercased asset basenames, for the mention pass `scan` does while reading. */
function basenamesOf(assets: readonly Asset[]): Set<string> {
  return new Set(
    assets.map((asset) => asset.relative.slice(asset.relative.lastIndexOf('/') + 1).toLowerCase()),
  );
}

/** Time one step. Returns both the value and how long it took. */
async function timed<T>(label: string, work: () => Promise<T> | T): Promise<[T, Timing]> {
  const started = performance.now();
  const value = await work();
  return [value, { label, ms: Math.round(performance.now() - started) }];
}

/**
 * The across-invocation report.
 *
 * Both spreads are shown because they answer different questions: the spread inside each
 * invocation says whether one process agreed with itself, and the spread between them
 * says whether separate processes did.
 */
function renderInvocations(
  sample: InvocationSample,
  invocations: number,
  runsEach: number,
): string {
  const verdict = !sample.samplesAgree
    ? 'UNUSABLE (these invocations disagree — machine health, not drift)'
    : sample.medianMs <= BUDGET_MS
      ? 'within the regression ceiling'
      : 'OVER the regression ceiling';

  return [
    '',
    'upfly-core bench — graph budget across separate invocations',
    '',
    `  ${invocations} invocations x median of ${runsEach} runs, on ${platform()} with ${cpus().length} cores`,
    `  UV_THREADPOOL_SIZE=${process.env.UV_THREADPOOL_SIZE ?? '4 (default)'}`,
    '',
    `  headline: ${sample.medianMs} ms of ${BUDGET_MS} ms  ${verdict}`,
    `  design target: ${DESIGN_TARGET_MS} ms — ${
      sample.medianMs <= DESIGN_TARGET_MS
        ? 'met'
        : 'NOT met, and the ceiling above is not that target'
    }`,
    `  per invocation: ${sample.medians.join(', ')} ms`,
    `  spread between invocations: ${sample.spreadPercent}% (min ${sample.minMs}, max ${sample.maxMs})`,
    `  spread inside each: ${sample.internalSpreadPercent.map((value) => `${value}%`).join(', ')}`,
    '',
    // Printed on every run, pass or fail. A tight spread above says these invocations
    // agreed with each other, not that the same commit will measure the same in the next
    // run, and that is the variation that matters.
    `  ⚠️ Agreement above is WITHIN this run. The headline drifts ${MEASURED_BETWEEN_RUN_DRIFT}`,
    '     on unchanged code, and that is invisible from inside a single run. The ceiling',
    '     carries headroom for it; the spread figure above does not protect against it.',
    '',
    sample.samplesAgree
      ? ''
      : '  ⚠️ These invocations disagree by more than 20%, which has never happened in CI.\n     Treat it as a machine-health problem with this run, not as drift.\n',
  ].join('\n');
}

function flagValue(name: string): string | undefined {
  return argv.find((flag) => flag.startsWith(`${name}=`))?.slice(name.length + 1);
}

async function main(): Promise<void> {
  const fresh = argv.includes('--fresh');

  // --- The breakdown child: one warm-up, then the variants it was given. ---------
  //
  // Spawned by `sampleBreakdowns`, never run by hand. It prints JSON and nothing else,
  // so anything written to stdout here breaks the parent process's parse.
  if (argv.includes('--breakdown-child')) {
    const generated = await generateTree({ fresh: false });
    const requested = (flagValue('--variants') ?? 'baseline')
      .split(',')
      .filter((name): name is Variant => (VARIANTS as readonly string[]).includes(name));

    // Discarded, for `sample()`'s reason: a read-dominated workload is dominated by the
    // filesystem cache, and a first pass measures a cold one. The JIT is cold too, and
    // the step this instrument exists to attribute is the one the JIT is compiling.
    await measureBreakdown(generated.root, 'baseline');

    const passes: Breakdown[] = [];
    for (const variant of requested) passes.push(await measureBreakdown(generated.root, variant));
    stdout.write(JSON.stringify(passes));
    return;
  }

  // --- The gate mode: sample across separate invocations, not within one. --------
  //
  // The in-process sampler controls the filesystem cache, not the process: invocations
  // that each agree closely with themselves can still land far apart. This spawns
  // children, so it must run before the work below rather than alongside it.
  const invocations = Number(
    argv.find((a) => a.startsWith('--invocations='))?.slice('--invocations='.length) ?? 0,
  );
  if (invocations > 0) {
    // Generated here rather than in a child, so `--fresh` wipes and rebuilds exactly
    // once. Every child below calls `generateTree` too and gets the completed tree back
    // without touching it.
    await generateTree({ fresh });
    const runsEach = Number(
      argv.find((a) => a.startsWith('--runs='))?.slice('--runs='.length) ?? 5,
    );
    const across = await sampleAcrossInvocations(invocations, runsEach);
    stdout.write(renderInvocations(across, invocations, runsEach));

    // Then a sampled per-step breakdown, so a CI run says which step moved. It runs after
    // the sampling, never interleaved with it, so its timing wrappers cannot touch the
    // figure the build gates on. Each pass is its own process for the reason
    // `invocations.ts` gives. `--experiments` adds the variants `breakdown.ts` interleaves
    // in one run, so its A/B survives the drift between runs; it is for local use, and CI
    // does not pass it.
    const variants = argv.includes('--experiments') ? VARIANTS : (['baseline'] as const);
    const breakdownPasses = Number(flagValue('--breakdown-passes') ?? invocations);
    const samples = await sampleBreakdowns(breakdownPasses, variants);
    const experiment = variants.length > 1;
    for (const sample of samples) stdout.write(renderBreakdown(sample, experiment));
    if (experiment) stdout.write(renderExperiment(samples));

    // `--measure-only` prints the figures without gating on them, which is how a ceiling
    // is measured on a runner before one is set: failing a build against a number
    // measured on another machine proves nothing.
    if (argv.includes('--measure-only')) {
      stdout.write('  (measure-only: not gating, so this cannot fail the build)\n\n');
      exit(0);
    }
    exit(across.samplesAgree && across.medianMs <= BUDGET_MS ? 0 : 1);
  }

  const json = argv.includes('--json');
  // The graph budget is the number CI watches on every push; the probe numbers cost
  // minutes and are wanted far less often.
  const graphOnly = argv.includes('--graph-only');

  const [tree, generation] = await timed('generate tree', () => generateTree({ fresh }));
  const readFileText = (path: string) => readFile(path, 'utf8');

  // --- 1. The graph budget: everything up to and including linking. -------------
  //
  // Sampled, not timed once: this is the number CI gates on, and a single run of it does
  // not repeat closely enough for that.
  const runs = Number(argv.find((a) => a.startsWith('--runs='))?.slice('--runs='.length) ?? 5);

  const [, graphBudget] = await sample('graph budget', runs, async () => {
    const started = performance.now();
    const found = await discover({ root: tree.root, adapters: ADAPTERS });
    const parsed = await scanSources({
      sourceFiles: found.sourceFiles,
      adapters: ADAPTERS,
      readFile: readFileText,
      assetBasenames: basenamesOf(found.assets),
    });
    const links = resolveReferences(parsed.references, {
      root: found.root,
      assets: found.assets,
      servingRoots: { dirs: ['public'], declared: true },
      excludedRoots: found.excludedRoots,
      exists: (path) => existsSync(path),
    });
    buildGraph({
      root: found.root,
      assets: found.assets,
      references: links,
      unscannedFiles: [...found.unscannedFiles, ...parsed.unscanned],
    });
    return performance.now() - started;
  });

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
      servingRoots: { dirs: ['public'], declared: true },
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

  // The per-step breakdown is a single pass: it says where the time goes, and the
  // sampled total above is what anyone may quote.
  const stepTotalMs = discoverMs.ms + scanMs.ms + resolveMs.ms + graphMs.ms;

  // --- 2. The sweep: zero-reference assets against the unread files. -------------
  const [sweep, sweepMs] = await timed('sweep', () =>
    sweepForMentions({
      graph,
      readFile: readFileText,
      scannedMentions: scanned.mentions,
      publicDirs: ['public'],
    }),
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
    audit({ graph, sweep, readFile: readFileText, publicDirs: ['public'], probes: cappedProbes }),
  );
  const [, reportMs] = await timed('report', () =>
    buildReport({
      graph,
      audit: auditResult,
      discovery,
      sweep,
      servingRoots: { dirs: ['public'], declared: true },
      probes: cappedProbes,
    }),
  );

  const result: BenchResult = {
    tree: { files: TOTAL_FILES, images: TOTAL_IMAGES, root: '<temp>' },
    graphBudget: {
      totalMs: graphBudget.medianMs,
      stepTotalMs,
      budgetMs: BUDGET_MS,
      withinBudget: graphBudget.samplesAgree && graphBudget.medianMs < BUDGET_MS,
      sample: graphBudget,
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
 * cap takes the largest first and those are the expensive ones; an average would
 * understate the cost of the assets the cap actually selects.
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
 * Whether the probe's pool helps, and where it stops helping.
 *
 * libvips already uses every core inside one encode, so the pool multiplies an already
 * parallel workload and its size cannot be worked out from the core count. This is what
 * the default of 4 in `probe.ts` rests on; `os.cpus() - 1`, the obvious guess, stays in
 * the sweep to compare against.
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

/** Plain text with no locale formatting, the same rule the report renderer follows. */
function render(result: BenchResult, generation: Timing): string {
  const lines: string[] = [
    'upfly-core bench',
    '',
    `  tree: ${result.tree.files} files, ${result.tree.images} images (generated in ${generation.ms} ms)`,
    `  machine: ${result.machine.platform}, ${result.machine.cpus} logical cores, UV_THREADPOOL_SIZE=${result.machine.uvThreadpoolSize}`,
    '',
    `Graph budget — ${result.graphBudget.totalMs} ms of ${result.graphBudget.budgetMs} ms  ${verdict(result.graphBudget)}`,
    '',
    `  median of ${result.graphBudget.sample.runs} runs (one warm-up discarded): ${result.graphBudget.sample.allMs.join(', ')} ms`,
    `  spread ${result.graphBudget.sample.spreadPercent}% (min ${result.graphBudget.sample.minMs}, max ${result.graphBudget.sample.maxMs})${result.graphBudget.sample.samplesAgree ? '' : '  ← SAMPLES DISAGREE'}`,
    '',
    '  where the time goes (single pass):',
  ];

  for (const step of result.graphBudget.steps) lines.push(`    ${pad(step.label)} ${step.ms} ms`);
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

/** `OK`, `OVER`, or `UNUSABLE` when the samples disagree too much to say either. */
function verdict(budget: BenchResult['graphBudget']): string {
  if (!budget.sample.samplesAgree) return 'UNUSABLE (samples disagree)';
  return budget.withinBudget ? 'OK' : 'OVER';
}

function pad(label: string): string {
  return `${label}:`.padEnd(24);
}

await main();
