/**
 * Where the graph build's time goes — sampled, so a step's movement can be attributed.
 *
 * 🔴 **R142 ruled this: the per-step breakdown was ONE pass and one pass cannot attribute
 * a change.** Two CI runs gave an accidental control. Over a commit that touched no parse
 * code, `parse` moved **−2.5% on ubuntu and +12.5% on windows**, and `scan` and
 * `read (wall)` flipped sign too — a 15-point spread on steps nobody edited. The
 * instrument's own label was honest (*"it attributes a change to a step; it is NOT a
 * number to quote"*) but attributing a change to a step is exactly what a single sample
 * cannot do.
 *
 * ## 🔴 The fix as ruled does not measure the quantity the ruling was drawn from (R143)
 *
 * R142's control is **between CI runs**. Repeating the pass N times **inside one run**
 * measures a different and much smaller thing, and `invocations.ts` has already measured
 * both: between-invocation spread is **2–9%** while the headline itself drifts **17–22%
 * between runs of unchanged code**. That module's own comment says why, and it is
 * structural rather than fixable: *"between-run drift is invisible from inside a single
 * run, by construction."*
 *
 * ⚠️ **So a tight spread printed here is exactly the reading that made `usable` a
 * misleading name** before it was renamed `samplesAgree`. This module therefore:
 *
 * - reports a **per-step median and per-step spread**, and prints **UNUSABLE** beside any
 *   step whose spread crosses the line — R142's literal ask, and it is worth having: it
 *   is what says a 69 ms `graph` step cannot resolve a 10% change at all;
 * - states on **every** run that its own spread is **not** the attribution floor, and
 *   repeats the measured between-run drift beside it;
 * - and carries the thing that actually beats drift: **an A/B inside one run.**
 *
 * ## ✅ The A/B, and why the variants are a partition when read-wall and parse are not
 *
 * `scan` is read-wall ∪ parse ∪ the mention pass ∪ overhead, and the first two **overlap**
 * — the bench has printed that warning on every run since the first version of it summed
 * concurrent reads and reported 853%. Those cannot be subtracted from each other.
 *
 * What CAN be subtracted is the **same quantity under three treatments**. All three
 * variants measure `scan` wall clock on the same tree in the same job:
 *
 * | variant | what it removes | what the difference from the one above it is |
 * |---|---|---|
 * | `baseline` | nothing | — |
 * | `no-parse` | every adapter returns `[]` | **what parsing costs** (R141 experiment 1) |
 * | `no-parse-no-mentions` | also the basename mention pass | what the mention pass costs |
 *
 * The last row is the I/O floor, and it is in here because without it R141's experiment
 * can confirm but not refute (R117). R141's reading is *"stays near 5,000 ms → the disk
 * is the bottleneck"* — but `collectMentions` runs synchronously on the main thread for
 * every file too, and R19 measured it at **1,325 ms**. A `no-parse` run that stayed high
 * would have been read as a disk floor when a third of it was the main thread after all.
 *
 * ⚠️ **Variants are interleaved and ROTATED across processes** — child 0 runs A,B,C, child
 * 1 runs B,C,A, child 2 runs C,A,B — so neither run-to-run drift nor JIT order can favour
 * one variant. That is B11's BEFORE/AFTER/BEFORE bracket and `noise.ts`'s `--pair`, which
 * is the one design in this project that has ever survived its own noise floor.
 *
 * Reads only; writes nothing anywhere (R52).
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  type Adapter,
  type Asset,
  buildGraph,
  defaultAdapters,
  discover,
  resolveReferences,
  scanSources,
} from 'upfly-core';
import { MEASURED_BETWEEN_RUN_DRIFT } from './invocations.js';
import { type Summary, summarise } from './samples.js';

const exec = promisify(execFile);
const ADAPTERS: readonly Adapter[] = defaultAdapters;

/**
 * The treatments.
 *
 * The first three are R141 experiment 1 and each removes the one above it plus one more,
 * so consecutive differences are the cost of what was removed. The last two are
 * **experiment 2**, which is the same work under a raised libuv threadpool.
 *
 * 🔴 **`UV_THREADPOOL_SIZE` is read by libuv when the pool is first used and cannot be
 * changed afterwards, so it is a property of the PROCESS.** That is why it is a spawn-time
 * `env` here rather than an assignment — and it is also §3.4's rule arriving from the
 * other direction: *set it in the CLI entry point, never in the library.* The bench parent
 * sets it on a child it owns. Nothing in `upfly-core` touches it.
 *
 * ⛔ **The threadpool variants are GONE (R146): experiment 2 is closed, four paired
 * comparisons inside the spread on both platforms.** The last variant is R134's parse
 * pool, which is the only one that ADDS engine behaviour rather than removing some — so it
 * is the only one whose figure is a result rather than a bound.
 */
interface VariantSpec {
  readonly label: string;
  readonly stubParse: boolean;
  readonly withMentions: boolean;
  /** Extra environment for the child process that measures it. */
  readonly env: Readonly<Record<string, string>>;
  /** Run `scanSources` with R134's parse pool engaged. */
  readonly pool?: boolean;
}

export const VARIANTS = ['baseline', 'no-parse', 'no-parse-no-mentions', 'pooled'] as const;
export type Variant = (typeof VARIANTS)[number];

/** R141 experiment 1's three treatments, which are a partition of `scan`. */
export const EXPERIMENT_1: readonly Variant[] = ['baseline', 'no-parse', 'no-parse-no-mentions'];
/**
 * ⛔ **R141 EXPERIMENT 2 IS CLOSED AND ITS VARIANTS ARE DELETED (R146).**
 *
 * CI ran it: **four paired comparisons across both platforms, every one inside the
 * spread.** R19 was right, R12's 26% was laptop noise, and this chat's own laptop reading
 * of −18.9% did not survive CI either. 🔴 **Nothing should re-run it** — a dead experiment
 * left in the harness costs CI time on every push forever and is eventually read as an open
 * question. The ruling holds the result; the harness does not need to keep asking.
 *
 * ⚠️ **The spawn-time `env` machinery it needed is KEPT**, because it cost nothing and
 * R141's experiment 3 may want it.
 */
export const EXPERIMENT_2_CLOSED = true;

export const VARIANT_SPEC: Readonly<Record<Variant, VariantSpec>> = {
  baseline: { label: 'baseline', stubParse: false, withMentions: true, env: {} },
  'no-parse': { label: 'no parse (R141 exp. 1)', stubParse: true, withMentions: true, env: {} },
  'no-parse-no-mentions': {
    label: 'no parse, no mentions',
    stubParse: true,
    withMentions: false,
    env: {},
  },
  // 🔴 R134's parse pool, measured against `baseline` in the same run. It is the only
  // variant that changes ENGINE behaviour rather than removing some of it, so it is the
  // only one whose number is a result rather than a bound.
  pooled: { label: 'pooled (R134)', stubParse: false, withMentions: true, env: {}, pool: true },
};

export const VARIANT_LABEL: Readonly<Record<Variant, string>> = Object.freeze(
  Object.fromEntries(VARIANTS.map((variant) => [variant, VARIANT_SPEC[variant].label])) as Record<
    Variant,
    string
  >,
);

/**
 * Above this a step's samples disagree too much to attribute a change to it.
 *
 * ⚠️ **INHERITED, NOT CHOSEN.** 20% is the line `invocations.ts` and `run.ts` already
 * draw, and picking a different one here from taste is what R127 warns about — a number
 * chosen by taste is how `os.cpus() - 1` became a default 21% worse than 4. It is a
 * machine-health line, exactly as it is there: a step that crosses it had something
 * wrong with it, not merely a small signal. **Re-size it from the first CI run that
 * prints per-step spreads, never from a laptop.**
 */
export const MAX_STEP_SPREAD_PERCENT = 20;

export interface Breakdown {
  readonly variant: Variant;
  readonly discoverMs: number;
  readonly scanMs: number;
  readonly resolveMs: number;
  readonly graphMs: number;
  /** Wall-clock window with at least one read outstanding. Overlaps `parseMs`. */
  readonly readMs: number;
  /** Summed read durations. Divided by `readMs`, the effective concurrency. */
  readonly readOccupancyMs: number;
  /** Summed adapter time. Synchronous, so this IS elapsed time. */
  readonly parseMs: number;
  /** JSON-friendly, because this crosses a process boundary. A `Map` would not. */
  readonly parseByExtension: readonly (readonly [string, number])[];
  /** R86, and printed even when zero. */
  readonly adapterThrows: number;
  readonly files: number;
  readonly references: number;
  /**
   * What `scanSources` said about the pool.
   *
   * 🔴 Carried through to the render because a pool that declined to engage and a pool
   * that engaged and bought nothing produce the same number and call for opposite
   * responses. `not-requested` on the `pooled` variant would mean this measurement is of
   * the baseline wearing another name.
   */
  readonly poolReason: string;
  readonly poolWorkers: number;
  readonly poolFellBack: number;
}

/**
 * One instrumented pass.
 *
 * ✅ **Read against parse is measured from OUTSIDE the engine, with no core change.**
 * `scanSources` takes its reader and its adapters as parameters, so wrapping both
 * accumulates the real in-run cost of each — interleaved, at the real concurrency, in the
 * real execution order. A read-everything-then-parse-everything probe would decompose a
 * *different* execution and report it as this one's shape, which is precisely how the
 * "~72% is parsing" figure was arrived at and later withdrawn (R141).
 *
 * ⚠️ **A throw is a third outcome (R86).** An adapter that throws still spent time
 * parsing, and a wrapper recording only the success path would under-count exactly the
 * files that are hardest to parse. The timing is taken in `finally` and the throw is
 * re-thrown untouched — including `UpflyError.partial`, which R134 warns must survive
 * every boundary it crosses.
 */
export async function measureBreakdown(root: string, variant: Variant): Promise<Breakdown> {
  const { stubParse, withMentions, pool } = VARIANT_SPEC[variant];

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
  // as a partition of `scan`. 🔴 And the window closes in a `finally`, which runs on the
  // MAIN THREAD — so while the main thread parses file A, file B's completed read is
  // still counted as outstanding. That is R141's inference, and the `no-parse` variant
  // is what turns it from an inference into a measurement: read-wall should collapse.
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
        // 🔴 R141 experiment 1, and it is the whole of it: scan every file, return no
        // references. The wrapper stays on so the stub's own cost is visible rather
        // than assumed to be zero, and `extensions`/`id` are untouched so `discover`
        // claims exactly the same files — which the renderer then asserts.
        return stubParse ? [] : adapter.findReferences(input);
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
    // Spread rather than `: undefined`, which `exactOptionalPropertyTypes` rejects —
    // and rightly: "absent" and "present but undefined" are different states, and the
    // mention pass's absence is the treatment being measured.
    ...(withMentions ? { assetBasenames: basenamesOf(found.assets) } : {}),
    // 🔴 R134. `minFiles: 1` because the engagement floor is a separate question with its
    // own instrument (`pool-floor.ts`); here the pool is being measured at full size and a
    // floor that declined to engage would silently make this variant the baseline again.
    ...(pool === true ? { pool: { minFiles: 1 } } : {}),
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
    variant,
    discoverMs,
    scanMs,
    resolveMs,
    graphMs,
    readMs,
    readOccupancyMs,
    parseMs,
    parseByExtension: [...parseByExtension.entries()],
    adapterThrows,
    files: found.sourceFiles.length,
    references: parsed.references.length,
    poolReason: parsed.pool.reason,
    poolWorkers: parsed.pool.workers,
    poolFellBack: parsed.pool.fellBack,
  };
}

/** Lowercased asset basenames, for the mention pass `scan` does while reading. */
function basenamesOf(assets: readonly Asset[]): Set<string> {
  return new Set(
    assets.map((asset) => asset.relative.slice(asset.relative.lastIndexOf('/') + 1).toLowerCase()),
  );
}

/** One variant's passes, summarised per step. */
export interface BreakdownSample {
  readonly variant: Variant;
  readonly passes: number;
  readonly discover: Summary;
  readonly scan: Summary;
  readonly read: Summary;
  readonly parse: Summary;
  readonly resolve: Summary;
  readonly graph: Summary;
  readonly readOccupancy: Summary;
  /** Every pass saw the same tree, so a disagreement here invalidates the comparison. */
  readonly fileCounts: readonly number[];
  readonly references: number;
  readonly adapterThrows: number;
  /** What the pool did, from the median pass. `not-requested` means it never ran. */
  readonly poolReason: string;
  readonly poolWorkers: number;
  readonly poolFellBack: number;
  /** From the pass whose `scan` was the median, so it describes a real single execution. */
  readonly parseByExtension: readonly (readonly [string, number])[];
  /** Step labels whose spread crossed `MAX_STEP_SPREAD_PERCENT`. */
  readonly unusableSteps: readonly string[];
}

export function summariseBreakdowns(passes: readonly Breakdown[]): BreakdownSample {
  const first = passes[0];
  if (first === undefined) throw new Error('summariseBreakdowns needs at least one pass');

  const of = (pick: (pass: Breakdown) => number) => summarise(passes.map(pick));
  const discover = of((pass) => pass.discoverMs);
  const scan = of((pass) => pass.scanMs);
  const read = of((pass) => pass.readMs);
  const parse = of((pass) => pass.parseMs);
  const resolve = of((pass) => pass.resolveMs);
  const graph = of((pass) => pass.graphMs);

  // The median pass by `scan`, so `parse by extension` describes one real execution
  // rather than an average of executions that never happened.
  const byScan = [...passes].sort((a, b) => a.scanMs - b.scanMs);
  const median = byScan[Math.floor((byScan.length - 1) / 2)] ?? first;

  const unusableSteps = (
    [
      ['discover', discover],
      ['scan', scan],
      ['read (wall)', read],
      ['parse', parse],
      ['resolve', resolve],
      ['graph', graph],
    ] as const
  )
    .filter(([, summary]) => summary.spreadPercent > MAX_STEP_SPREAD_PERCENT)
    .map(([label]) => label);

  return {
    variant: first.variant,
    passes: passes.length,
    discover,
    scan,
    read,
    parse,
    resolve,
    graph,
    readOccupancy: of((pass) => pass.readOccupancyMs),
    fileCounts: [...new Set(passes.map((pass) => pass.files))],
    references: median.references,
    adapterThrows: median.adapterThrows,
    poolReason: median.poolReason,
    poolWorkers: median.poolWorkers,
    poolFellBack: passes.reduce((sum, pass) => sum + pass.poolFellBack, 0),
    parseByExtension: median.parseByExtension,
    unusableSteps,
  };
}

/**
 * Run the instrumented pass across separate processes, interleaving the variants.
 *
 * A fresh process per sample for the reason `invocations.ts` gives: the in-process
 * sampler controls the filesystem cache and nothing else. Each child discards one
 * warm-up pass before it measures anything, which is `run.ts`'s `sample()` ruling and
 * not a new decision — the old single-pass breakdown ran cold in the parent, after that
 * parent had spawned all the sampling children and therefore never warmed its own JIT.
 */
export async function sampleBreakdowns(
  processes: number,
  variants: readonly Variant[],
): Promise<BreakdownSample[]> {
  const script = fileURLToPath(new URL('run.js', import.meta.url));
  const collected = new Map<Variant, Breakdown[]>(variants.map((variant) => [variant, []]));

  // 🔴 Grouped by environment because `UV_THREADPOOL_SIZE` is a property of the PROCESS:
  // libuv reads it when the pool is first used and it cannot be changed after. Variants
  // that need the same environment share a child; variants that need a different one get
  // their own. Each group is still rotated, so no variant is always measured first.
  const groups = new Map<string, Variant[]>();
  for (const variant of variants) {
    const key = JSON.stringify(VARIANT_SPEC[variant].env);
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [variant]);
    else bucket.push(variant);
  }

  for (let index = 0; index < processes; index++) {
    for (const [key, members] of groups) {
      const rotated = rotate(members, index);
      const { stdout: out } = await exec(
        process.execPath,
        [script, '--breakdown-child', `--variants=${rotated.join(',')}`],
        {
          maxBuffer: 32 * 1024 * 1024,
          env: { ...process.env, ...(JSON.parse(key) as Record<string, string>) },
        },
      );
      for (const pass of JSON.parse(out) as Breakdown[]) {
        collected.get(pass.variant)?.push(pass);
      }
    }
  }

  return variants.map((variant) => summariseBreakdowns(collected.get(variant) ?? []));
}

/** Child `i` starts at variant `i`, so no variant is always first or always last. */
export function rotate<T>(values: readonly T[], by: number): readonly T[] {
  if (values.length === 0) return values;
  const offset = ((by % values.length) + values.length) % values.length;
  return [...values.slice(offset), ...values.slice(0, offset)];
}

export function renderBreakdown(sample: BreakdownSample): string {
  const total =
    sample.discover.medianMs +
    sample.scan.medianMs +
    sample.resolve.medianMs +
    sample.graph.medianMs;
  const share = (ms: number) => `${((ms / Math.max(1, total)) * 100).toFixed(1)}%`;
  const row = (label: string, summary: Summary) =>
    `    ${label.padEnd(14)} ${String(summary.medianMs).padStart(7)} ms   ${`${summary.spreadPercent}%`.padStart(5)}${
      summary.spreadPercent > MAX_STEP_SPREAD_PERCENT ? ' UNUSABLE' : '         '
    }  ${share(summary.medianMs).padStart(6)}`;

  const top = [...sample.parseByExtension]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([extension, ms]) => `${extension} ${Math.round(ms)}ms`)
    .join(' · ');

  return [
    '',
    `  Where the time goes — ${VARIANT_LABEL[sample.variant]}, median of ${sample.passes} instrumented`,
    '  passes in separate processes. NOT the gate number.',
    '',
    '    step              median  spread             share',
    row('discover', sample.discover),
    row('scan', sample.scan),
    row('  read (wall)', sample.read),
    row('  parse', sample.parse),
    row('resolve', sample.resolve),
    row('graph', sample.graph),
    '',
    `    per pass — scan: ${sample.scan.allMs.join(', ')} ms · parse: ${sample.parse.allMs.join(', ')} ms`,
    `    read occupancy ${sample.readOccupancy.medianMs} ms over ${sample.read.medianMs} ms wall = ${(
      sample.readOccupancy.medianMs / Math.max(1, sample.read.medianMs)
    ).toFixed(1)}x concurrency`,
    '    ⚠️ read-wall and parse OVERLAP and are not a partition of scan. Do not add them.',
    '',
    `    parse by extension: ${top}`,
    `    adapters that threw (R86): ${sample.adapterThrows}`,
    `    ${sample.fileCounts.join('/')} source files, ${sample.references} references`,
    ...(sample.fileCounts.length > 1
      ? ['    🔴 THE PASSES SAW DIFFERENT TREES. Nothing below is comparable.']
      : []),
    '',
    // 🔴 R143. Printed on EVERY run, pass or fail, for the same reason `renderInvocations`
    // prints its drift line: a tight spread here says these passes agreed inside ONE run,
    // and R142's 15-point control was measured BETWEEN runs, which this cannot see.
    `    ⚠️ The spreads above are WITHIN this run. The headline drifts ${MEASURED_BETWEEN_RUN_DRIFT}`,
    '       on unchanged code and these steps drift with it, so a spread here is NOT the',
    '       attribution floor for a change measured against a PREVIOUS run. What beats that',
    '       drift is an A/B inside one run — which is what the experiment block below is.',
    '',
  ].join('\n');
}

/**
 * The A/B, and the only reading in this file that survives run-to-run drift.
 *
 * Consecutive variants differ by one removed thing, so each difference names a cost.
 * ✅ **These ARE a partition** — every row is `scan` wall clock, measured the same way,
 * under a different treatment, in the same job. That is what read-wall and parse are not.
 */
export function renderExperiment(samples: readonly BreakdownSample[]): string {
  const baseline = samples.find((sample) => sample.variant === 'baseline');
  const noParse = samples.find((sample) => sample.variant === 'no-parse');
  const noMentions = samples.find((sample) => sample.variant === 'no-parse-no-mentions');
  if (baseline === undefined || noParse === undefined) return '';

  const partition = samples.filter((sample) => EXPERIMENT_1.includes(sample.variant));

  const lines: string[] = [
    '',
    '  R141 experiment 1 — what `scan` costs with parsing stubbed to a no-op',
    '',
    '    variant                     scan       spread        vs baseline',
  ];

  for (const sample of partition) {
    const delta =
      sample === baseline
        ? '—'
        : `${percent(sample.scan.medianMs - baseline.scan.medianMs, baseline.scan.medianMs)}`;
    lines.push(
      `    ${VARIANT_LABEL[sample.variant].padEnd(24)} ${String(sample.scan.medianMs).padStart(6)} ms  ${`${sample.scan.spreadPercent}%`.padStart(5)}${
        sample.unusableSteps.includes('scan') ? ' UNUSABLE' : '         '
      }  ${delta.padStart(10)}`,
    );
  }

  const parseCost = baseline.scan.medianMs - noParse.scan.medianMs;
  const mentionCost =
    noMentions === undefined ? null : noParse.scan.medianMs - noMentions.scan.medianMs;
  const floor = noMentions?.scan.medianMs ?? null;

  lines.push(
    '',
    `    parsing costs           ${String(parseCost).padStart(6)} ms  ${percentOf(parseCost, baseline.scan.medianMs)} of scan`,
    ...(mentionCost === null || floor === null
      ? []
      : [
          `    the mention pass costs  ${String(mentionCost).padStart(6)} ms  ${percentOf(mentionCost, baseline.scan.medianMs)} of scan`,
          `    everything else         ${String(floor).padStart(6)} ms  ${percentOf(floor, baseline.scan.medianMs)} of scan  ← reads, the walk, and scan's own overhead`,
        ]),
    '',
    `    read (wall) ${baseline.read.medianMs} → ${noParse.read.medianMs} ms with parse stubbed (${percent(noParse.read.medianMs - baseline.read.medianMs, baseline.read.medianMs)}).`,
    "    🔴 R141's claim is that read-wall is inflated by parse because `timedRead`'s",
    '       `finally` runs on the main thread. That line is the test of it: a read-wall',
    '       that barely moves means the window really was waiting on a disk.',
    '',
    '    ✅ These rows ARE a partition: all of them are `scan` wall under three treatments,',
    '       measured in the same job. read-wall and parse are not, and still must not be added.',
    '',
    ...verdict(baseline, noParse, parseCost),
    '',
  );

  return lines.join('\n');
}

/**
 * R134's parse pool, read against the baseline in the same run.
 *
 * 🔴 **This is the only figure in this file that is a RESULT rather than a bound.** The
 * `no-parse` variants say what parsing costs — an upper limit on what any pool could ever
 * recover. This says what one actually recovered, and the difference between those two
 * numbers is everything the pool spends on spin-up, cloning and serialisation.
 *
 * ✅ **CI measured the target before the pool existed:** parse is 69.4% of `scan` on
 * Windows, and with every main-thread cost removed `scan` floors at 926 ms, putting the
 * whole build at roughly 1,360 ms against §3.4's 3,000 ms. **So there is ~1,600 ms of
 * headroom and this may waste most of it and still pass.**
 *
 * 🔴 **The first line to read is not the time, it is `reason`.** A pool that declined to
 * engage produces the baseline's number under the pool's name, and a reader looking at a
 * table of milliseconds cannot tell those apart.
 */
export function renderPool(samples: readonly BreakdownSample[]): string {
  const baseline = samples.find((sample) => sample.variant === 'baseline');
  const pooled = samples.find((sample) => sample.variant === 'pooled');
  const floor = samples.find((sample) => sample.variant === 'no-parse-no-mentions');
  if (baseline === undefined || pooled === undefined) return '';

  const move =
    ((pooled.scan.medianMs - baseline.scan.medianMs) / Math.max(1, baseline.scan.medianMs)) * 100;
  const spread = spreadFloor(baseline, pooled);
  const ceiling =
    floor === undefined
      ? null
      : ((floor.scan.medianMs - baseline.scan.medianMs) / Math.max(1, baseline.scan.medianMs)) *
        100;

  return [
    '',
    '  R134 — the parse pool, against the baseline in this same run',
    '',
    `    pool engaged: ${pooled.poolReason}   workers: ${pooled.poolWorkers}   files handed back: ${pooled.poolFellBack}`,
    ...(pooled.poolReason === 'engaged'
      ? []
      : ['    🔴 THE POOL DID NOT RUN. Every number below is the baseline under another name.']),
    ...(pooled.poolFellBack === 0
      ? []
      : [`    🔴 ${pooled.poolFellBack} FILES FELL BACK TO THE MAIN THREAD. A worker is failing.`]),
    '',
    `    scan   ${String(baseline.scan.medianMs).padStart(6)} ms  ->  ${String(pooled.scan.medianMs).padStart(6)} ms   ${`${move >= 0 ? '+' : ''}${move.toFixed(1)}%`}${
      spread === null
        ? '   ONE PASS — no floor to place this against'
        : Math.abs(move) <= spread
          ? `   inside the ${spread}% spread — NOT a finding`
          : `   outside the ${spread}% spread`
    }`,
    ...(ceiling === null
      ? []
      : [
          `    the ceiling, from the same run: ${ceiling.toFixed(1)}% — what removing ALL main-thread`,
          '    work does. The gap between that and the line above is what the pool spends on',
          '    spin-up, cloning and serialisation.',
        ]),
    '',
    '    ⚠️ Correctness is asserted elsewhere and not here: `scan-pool.test.ts` runs the',
    '       pooled and unpooled scans over a file that throws WITH partial references and',
    '       requires byte-identical output (R134). A faster wrong answer is not a result.',
    '',
  ].join('\n');
}

/**
 * R141's decision rule, applied out loud — and refused when the spreads cannot carry it.
 *
 * ⚠️ **Stated as a share rather than as R141's absolute 1,500 / 5,000 ms**, because those
 * are this tree on this runner and the same rule has to survive both changing. The
 * question underneath is unchanged: is the main thread the bottleneck, or is the disk.
 */
/**
 * The noise floor two samples share, or `null` when there is not one.
 *
 * 🔴 **One pass has a spread of 0% and that is not a floor, it is an absence.**
 * `noise.test.ts` records the same trap on the same arithmetic: *"calls a single sample
 * perfectly tight, which is true and is why `--cold` needs reading"*. A verdict placed
 * against a 0% floor derived from one draw is R12's *"26% off"* being born again.
 */
function spreadFloor(a: BreakdownSample, b: BreakdownSample): number | null {
  if (a.passes < 2 || b.passes < 2) return null;
  return Math.max(a.scan.spreadPercent, b.scan.spreadPercent);
}

function verdict(
  baseline: BreakdownSample,
  noParse: BreakdownSample,
  parseCost: number,
): readonly string[] {
  const floor = spreadFloor(baseline, noParse);
  const movePercent = (Math.abs(parseCost) / Math.max(1, baseline.scan.medianMs)) * 100;

  if (floor === null) {
    return [
      `    VERDICT: parsing is ${((parseCost / Math.max(1, baseline.scan.medianMs)) * 100).toFixed(1)}% of scan's wall clock — but this ran ONE pass`,
      '       per variant, so there is no spread to place it against. R141 expects ~−70%, which',
      '       survives one sample; nothing smaller does. Re-run with --breakdown-passes=3.',
    ];
  }

  const floorPercent = floor;

  if (movePercent <= floorPercent) {
    return [
      `    VERDICT: NONE. The difference is ${movePercent.toFixed(1)}% and these variants' own spread is`,
      `       ${floorPercent}%. A move inside the noise is not a finding — that is how R12's "26% off"`,
      '       entered the spec and later measured zero. Raise the pass count and re-run.',
    ];
  }

  const share = (parseCost / Math.max(1, baseline.scan.medianMs)) * 100;
  return share >= 50
    ? [
        `    VERDICT: parsing is ${share.toFixed(1)}% of scan's wall clock. The MAIN THREAD is the`,
        "       bottleneck, and R134's pool is aimed at the right thing. That share is also its",
        '       CEILING: a perfect pool removes this and no more.',
      ]
    : [
        `    VERDICT: parsing is only ${share.toFixed(1)}% of scan's wall clock, so a parse pool's`,
        "       ceiling is that much and R141's second reading holds — the answer is the",
        '       threadpool or the read strategy, not a pool. 🔴 This is the result that costs',
        '       a week if it is ignored. Take it to Rinkal before any pool code (R134).',
      ];
}

function percent(delta: number, of: number): string {
  const value = (delta / Math.max(1, of)) * 100;
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function percentOf(part: number, whole: number): string {
  return `${((part / Math.max(1, whole)) * 100).toFixed(1)}%`;
}
