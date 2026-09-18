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
import { extname } from 'node:path';
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
import { TOTAL_FILES, TOTAL_IMAGES, generateTree } from './generate.js';
import {
  type InvocationSample,
  MEASURED_BETWEEN_RUN_DRIFT,
  sampleAcrossInvocations,
} from './invocations.js';

/**
 * §3.4's design target: what the graph build is supposed to cost.
 *
 * 🔴 **This is NOT the gate, and keeping the two apart is the point of having both.**
 * §5.1(g) failed against this and the target was deliberately not moved. A regression
 * ceiling loose enough not to flake is necessarily far above it, and a reader who sees
 * one number called "budget" will take a passing build for a met target. Both are
 * printed, always, with the relationship spelled out.
 */
const DESIGN_TARGET_MS = 3_000;

/**
 * The per-platform **regression ceiling**: don't get slower than this.
 *
 * ✅ **Set from CI on 2026-09-13, from three runs per platform** — the numbers the
 * workflow had been printing under `--measure-only` since the tree was recalibrated:
 *
 * | | run 1 | run 2 | run 3 | max | drift across runs |
 * |---|---|---|---|---|---|
 * | ubuntu | 3 299 | 4 022 | 4 165 | 4 165 | **21.5%** |
 * | windows | 4 758 | 5 233 | 5 641 | 5 641 | **16.9%** |
 *
 * 🔴 **The headroom is sized by the drift, not by taste.** On unchanged code the headline
 * moves up to 21.5% between runs, so a ceiling near the observed max is a coin flip —
 * and it demonstrably was one: at the old 3 500/5 000 the same commit reported `OVER`,
 * `within budget`, `OVER` on ubuntu and `within budget`, `OVER`, `OVER` on windows.
 * **The verdict flipped between runs of identical code, which is what a gate must not
 * do.** Max observed + ~30% puts the line clear of the noise.
 *
 * ⚠️ **What this can and cannot catch, stated so nobody over-reads a green build:** it
 * catches a regression larger than ~30%. It cannot catch a 10% one, because a 10% change
 * is smaller than the drift a single run carries. Catching those needs an A/B
 * back-to-back in one session — `bench/src/noise.ts`, floor 1-4% — not this gate.
 *
 * `UPFLY_BENCH_BUDGET_MS` still overrides, which is how the workflow pins it per platform.
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
 * A single sample is not a number. The graph budget came back at 6.1 s and then
 * 12.7 s on identical input, which made every conclusion drawn from it — including
 * the per-platform gate — provisional. Rule 16 says a claim is a number `bench/`
 * produced; a value that moves 2x between runs is not one.
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
  /** These samples agreed with each other. NOT a claim of reproducibility. */
  readonly samplesAgree: boolean;
}

/** Above this, the samples disagree too much to quote a number from them. */
const MAX_SPREAD_PERCENT = 20;

/**
 * Run `work` repeatedly and summarise it.
 *
 * The first pass is **discarded**. A read-dominated workload is dominated by the
 * filesystem cache, so the first run measures a cold cache and the rest measure a
 * warm one — averaging them together measures neither, which is the likeliest cause
 * of the 2x swing this exists to catch.
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
    /** False when over budget *or* when the samples disagreed too much to say. */
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
 * Both spreads are shown, because they answer different questions and conflating
 * them is what made the old number quotable when it should not have been: the
 * internal figure says whether one process agreed with itself, and the headline says
 * whether two processes did.
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
    `  §3.4 design target: ${DESIGN_TARGET_MS} ms — ${
      sample.medianMs <= DESIGN_TARGET_MS
        ? 'met'
        : 'NOT met, and the ceiling above is not that target'
    }`,
    `  per invocation: ${sample.medians.join(', ')} ms`,
    `  spread between invocations: ${sample.spreadPercent}% (min ${sample.minMs}, max ${sample.maxMs})`,
    `  spread inside each: ${sample.internalSpreadPercent.map((value) => `${value}%`).join(', ')}`,
    '',
    // 🔴 Printed on EVERY run, pass or fail. A tight spread above says these invocations
    // agreed with each other; it says nothing about whether the same commit measures the
    // same tomorrow, and that is the variation that actually bites.
    `  ⚠️ Agreement above is WITHIN this run. The headline drifts ${MEASURED_BETWEEN_RUN_DRIFT}`,
    '     on unchanged code, and that is invisible from inside a single run. The ceiling',
    '     carries headroom for it; the spread figure above does not protect against it.',
    '',
    sample.samplesAgree
      ? ''
      : '  ⚠️ These invocations disagree by more than 20%, which has never happened in CI.\n     Treat it as a machine-health problem with this run, not as drift.\n',
  ].join('\n');
}

/**
 * One instrumented pass, so CI can attribute a change to a STEP rather than to the run.
 *
 * 🔴 **R134's sequencing depends on this and nothing else does.** Three changes are queued
 * for the measured path: R132 lands in `resolve`, the markdown skip and the parse pool
 * both land in `parse`. Without a breakdown, separating them costs one CI round-trip each
 * — and CI is the only instrument that returns a usable number (R133: 1% spread against a
 * laptop's 29–85%). With it, R131 + R132 + the skip can land together and one run still
 * says which moved what.
 *
 * ✅ **Read against parse is measured from OUTSIDE the engine, with no core change.**
 * `scanSources` takes its reader and its adapters as parameters, so wrapping both
 * accumulates the real in-run cost of each — interleaved, at the real concurrency, in the
 * real execution order. A separate read-everything-then-parse-everything pass would have
 * decomposed a *different* execution and quietly reported it as this one's shape.
 *
 * ⚠️ **This pass is NOT the gate number and must never be quoted as one.** The wrappers add
 * two `performance.now()` calls per file, and one pass is one sample. The headline above it
 * stays clean: sampled, median of N, across separate invocations. This says only *where the
 * time went*.
 *
 * ⚠️ **A throw is a third outcome (R86).** An adapter that throws still spent time parsing,
 * and a wrapper that only records on the success path would under-count exactly the files
 * that are hardest to parse. The timing is taken in `finally` and the throw is re-thrown
 * untouched — including `UpflyError.partial`, which R134 warns must survive every boundary
 * it crosses.
 */
interface Breakdown {
  readonly discoverMs: number;
  readonly scanMs: number;
  readonly resolveMs: number;
  readonly graphMs: number;
  /** Inside `scan`: time spent in `readFile`, and time spent inside adapters. */
  /** Wall-clock window with at least one read outstanding. Overlaps `parseMs`. */
  readonly readMs: number;
  /** Summed read durations. Divided by `readMs`, the effective concurrency. */
  readonly readOccupancyMs: number;
  /** Summed adapter time. Synchronous, so this IS elapsed time. */
  readonly parseMs: number;
  readonly parseByExtension: ReadonlyMap<string, number>;
  /** R86, and printed even when zero. */
  readonly adapterThrows: number;
  readonly files: number;
  readonly references: number;
}

async function measureBreakdown(root: string): Promise<Breakdown> {
  let readMs = 0;
  let parseMs = 0;
  let adapterThrows = 0;
  const parseByExtension = new Map<string, number>();

  // 🔴 READS OVERLAP AND PARSES DO NOT, AND SUMMING BOTH THE SAME WAY IS WRONG.
  // The first version of this added up each read's elapsed time and printed it as a
  // share of the wall clock. It came out at **853%**, because `scanSources` reads in
  // concurrent batches — summing concurrent durations measures OCCUPANCY, not time.
  // Parsing is synchronous, so on one thread those durations cannot overlap and their
  // sum is real elapsed time.
  //
  // So reads are measured as the union of the intervals during which at least one was
  // in flight, which is the wall-clock window the process spent waiting on I/O. The
  // occupancy sum is kept beside it because their ratio is the effective concurrency,
  // which is worth knowing when a pool is being sized.
  //
  // ⚠️ **read-wall and parse are NOT additive.** A parse can run while another file's
  // read is outstanding, so they overlap and must never be added together or presented
  // as a partition of `scan`.
  let readOccupancyMs = 0;
  let readsInFlight = 0;
  let windowStarted = 0;

  const timedRead = async (path: string): Promise<string> => {
    const started = performance.now();
    if (readsInFlight === 0) windowStarted = started;
    readsInFlight++;
    try {
      return await readFile(path, 'utf8');
    } finally {
      const now = performance.now();
      readOccupancyMs += now - started;
      readsInFlight--;
      if (readsInFlight === 0) readMs += now - windowStarted;
    }
  };

  const timedAdapters: readonly Adapter[] = ADAPTERS.map((adapter) => ({
    ...adapter,
    findReferences(input) {
      const extension = extname(input.file).toLowerCase();
      const started = performance.now();
      try {
        return adapter.findReferences(input);
      } catch (error) {
        adapterThrows++;
        throw error;
      } finally {
        const spent = performance.now() - started;
        parseMs += spent;
        parseByExtension.set(extension, (parseByExtension.get(extension) ?? 0) + spent);
      }
    },
  }));

  const t0 = performance.now();
  const found = await discover({ root, adapters: timedAdapters });
  const discoverMs = performance.now() - t0;

  const t1 = performance.now();
  const parsed = await scanSources({
    sourceFiles: found.sourceFiles,
    adapters: timedAdapters,
    readFile: timedRead,
    assetBasenames: basenamesOf(found.assets),
  });
  const scanMs = performance.now() - t1;

  const t2 = performance.now();
  const links = resolveReferences(parsed.references, {
    root: found.root,
    assets: found.assets,
    servingRoots: { dirs: ['public'], declared: true },
    excludedRoots: found.excludedRoots,
    exists: (path) => existsSync(path),
  });
  const resolveMs = performance.now() - t2;

  const t3 = performance.now();
  buildGraph({
    root: found.root,
    assets: found.assets,
    references: links,
    unscannedFiles: [...found.unscannedFiles, ...parsed.unscanned],
  });
  const graphMs = performance.now() - t3;

  return {
    discoverMs,
    scanMs,
    resolveMs,
    graphMs,
    readMs,
    readOccupancyMs,
    parseMs,
    parseByExtension,
    adapterThrows,
    files: found.sourceFiles.length,
    references: parsed.references.length,
  };
}

function renderBreakdown(breakdown: Breakdown): string {
  const total = breakdown.discoverMs + breakdown.scanMs + breakdown.resolveMs + breakdown.graphMs;
  const share = (ms: number) => `${((ms / Math.max(1, total)) * 100).toFixed(1)}%`;
  const row = (label: string, ms: number) =>
    `    ${label.padEnd(14)} ${String(Math.round(ms)).padStart(7)} ms   ${share(ms).padStart(6)}`;

  const top = [...breakdown.parseByExtension.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([extension, ms]) => `${extension} ${Math.round(ms)}ms`)
    .join(' · ');

  return [
    '',
    '  Where the time goes — ONE instrumented pass, not the gate number',
    '',
    row('discover', breakdown.discoverMs),
    row('scan', breakdown.scanMs),
    row('  read (wall)', breakdown.readMs),
    row('  parse', breakdown.parseMs),
    row('resolve', breakdown.resolveMs),
    row('graph', breakdown.graphMs),
    '',
    `    read occupancy ${Math.round(breakdown.readOccupancyMs)} ms over ${Math.round(breakdown.readMs)} ms wall = ${(breakdown.readOccupancyMs / Math.max(1, breakdown.readMs)).toFixed(1)}x concurrency`,
    '    ⚠️ read-wall and parse OVERLAP and are not a partition of scan. Do not add them.',
    '',
    `    parse by extension: ${top}`,
    `    adapters that threw (R86): ${breakdown.adapterThrows}`,
    `    ${breakdown.files} source files, ${breakdown.references} references`,
    '',
    '  ⚠️ One pass, with timing wrappers on the reader and every adapter. It attributes',
    '     a change to a step; it is NOT a number to quote or gate against.',
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const fresh = argv.includes('--fresh');

  // --- The gate mode: sample across separate invocations, not within one. --------
  //
  // Ruled after three consecutive invocations reported medians 17% apart while each
  // was internally tight to 4-6%. The in-process sampler controls the filesystem
  // cache; it cannot control the process. This spawns children, so it must run
  // before the work below rather than alongside it.
  const invocations = Number(
    argv.find((a) => a.startsWith('--invocations='))?.slice('--invocations='.length) ?? 0,
  );
  if (invocations > 0) {
    const generated = await generateTree({ fresh });
    const runsEach = Number(
      argv.find((a) => a.startsWith('--runs='))?.slice('--runs='.length) ?? 5,
    );
    const across = await sampleAcrossInvocations(invocations, runsEach);
    stdout.write(renderInvocations(across, invocations, runsEach));

    // 🔴 R134 step 1. The gate number is above and is unchanged; this is one extra
    // instrumented pass so a CI run says WHICH STEP moved. R132 lands in `resolve`, the
    // markdown skip and the parse pool both land in `parse`, and without this each of
    // them costs its own CI round-trip to attribute — on the only instrument that
    // returns a usable number (R133: 1% spread, against a laptop's 29–85%).
    //
    // ⚠️ It runs AFTER the sampling, never interleaved with it, so the wrappers cannot
    // touch the figure the build gates on.
    stdout.write(renderBreakdown(await measureBreakdown(generated.root)));

    // `--measure-only` is what CI runs until a gate number exists that CI itself
    // produced. Reporting a number is useful; failing a build against a number
    // measured on somebody's laptop is not.
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
  // Sampled, not timed once. This is the number the gate uses, and a single run of
  // it disagreed with itself by 2x.
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

  // --- 2. The sweep, which R8 requires be measured. ------------------------------
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

/** `OK`, `OVER`, or a refusal to say — the third is not a failure, it is honesty. */
function verdict(budget: BenchResult['graphBudget']): string {
  if (!budget.sample.samplesAgree) return 'UNUSABLE (samples disagree)';
  return budget.withinBudget ? 'OK' : 'OVER';
}

function pad(label: string): string {
  return `${label}:`.padEnd(24);
}

await main();
