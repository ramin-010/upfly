/**
 * Where the parse pool's unexplained milliseconds go — R152's one measurement, and no fix.
 *
 * ## 🔴 The finding this exists to explain
 *
 * CI measured the pool **31.7% SLOWER** than the main thread: `scan` 4,075 → 5,366 ms, an
 * A/B inside one run, outside the 2% spread, **0 files handed back and byte-identical
 * output**. And every piece of the diagnosis held — **`parse` 0 ms on the main thread**,
 * **`read (wall)` 3,847 → 888 ms (−77%)**, ceiling −85.6%. 🔴 **The physics is right and
 * the plumbing costs more than the physics saves.** Those are different problems and only
 * the second is open.
 *
 * The arithmetic that leaves the hole: pooled `scan` 5,366, reads 888, main-thread parse 0.
 * The work that moved is 2,920 + 569 = **3,489 ms**, about **872 ms** across four workers,
 * overlapping the reads. **So roughly 4,400 ms is machinery of an unmeasured kind.**
 *
 * ## ⚠️ Why this measures three things and fixes none of them
 *
 * R152: *"Do not batch the messages, do not move reads into the workers, do not touch
 * anything until the split exists. Three candidate causes and one unmeasured number is how
 * a week disappears."* It also named its own suspicion and forbade building on it —
 * *"~0.57 ms per file points at round-trip latency rather than copying — THAT IS AN
 * INFERENCE, NOT A MEASUREMENT (R136)"*. So each candidate gets a measurement that can
 * come back small:
 *
 * | candidate | how it is measured | how it could say "not me" |
 * |---|---|---|
 * | **spin-up** | the pool times its own construction to the last worker's ready message | a few hundred ms against a 4,400 ms hole |
 * | **transport** | a `ping` round trip doing NO work, empty against a real file's text | latency × files lands far under the hole |
 * | **barrier tails** | `concurrency` swept — 7,681 files at 16 per barrier is 480 tails | raising it changes nothing |
 *
 * ✅ **The barrier sweep needs no new code and no fix.** `scanSources` already takes
 * `concurrency`; raising it removes barriers. That turns R150's *"required"* into
 * *"testable"* without touching the shipped path, which is exactly what R152 asked for.
 *
 * ⚠️ **`workerParseMs` and `roundTripMs` OVERLAP and are not a partition.** Four workers
 * run at once, so those are occupancy across all of them; only `poolActiveMs` is wall
 * clock. Adding them is the mistake the read/parse breakdown was built to prevent.
 *
 * Reads only; writes nothing anywhere (R52).
 *
 * Usage:
 *   pnpm --filter upfly-bench run pool-anatomy
 *   pnpm --filter upfly-bench run pool-anatomy -- --concurrency=16,64,256,1024 --repeats=3
 */

import { readFile } from 'node:fs/promises';
import { cpus, platform } from 'node:os';
import { argv, stdout } from 'node:process';
import {
  type Adapter,
  type Asset,
  DEFAULT_POOL_WORKERS,
  type ScanPoolAnatomy,
  createScanPool,
  defaultAdapters,
  discover,
  scanSources,
} from 'upfly-core';
import { generateTree } from './generate.js';
import { summarise } from './samples.js';

const ADAPTERS: readonly Adapter[] = defaultAdapters;

function basenamesOf(assets: readonly Asset[]): Set<string> {
  return new Set(
    assets.map((asset) => asset.relative.slice(asset.relative.lastIndexOf('/') + 1).toLowerCase()),
  );
}

interface Run {
  readonly concurrency: number;
  readonly pooled: boolean;
  readonly scanMs: number;
  readonly anatomy: ScanPoolAnatomy | null;
}

async function scanOnce(
  sourceFiles: Parameters<typeof scanSources>[0]['sourceFiles'],
  assetBasenames: ReadonlySet<string>,
  concurrency: number,
  pooled: boolean,
  workers: number = DEFAULT_POOL_WORKERS,
): Promise<Run> {
  const started = performance.now();
  const result = await scanSources({
    sourceFiles,
    adapters: ADAPTERS,
    readFile: (path: string) => readFile(path, 'utf8'),
    assetBasenames,
    concurrency,
    ...(pooled ? { pool: { minFiles: 1, workers } } : {}),
  });
  return {
    concurrency,
    pooled,
    scanMs: performance.now() - started,
    anatomy: result.pool.anatomy ?? null,
  };
}

/**
 * What one round trip costs with the work taken out.
 *
 * 🔴 **Serial, and that is the measurement rather than a convenience.** A latency taken
 * while four trips are in flight measures the queue. The payload is a real file's text, so
 * the difference between the two rows is the copy and nothing else.
 */
async function measurePing(
  text: string,
  iterations: number,
): Promise<{ empty: number; payload: number } | null> {
  const pool = createScanPool(1, undefined);
  if (pool === null) return null;

  // Discarded: the first trip pays for the worker still loading its modules, which is
  // spin-up and is measured separately. A latency that includes it is not a latency.
  for (let index = 0; index < 20; index++) await pool.ping('');

  const empty: number[] = [];
  const payload: number[] = [];
  for (let index = 0; index < iterations; index++) {
    let at = performance.now();
    await pool.ping('');
    empty.push(performance.now() - at);
    at = performance.now();
    await pool.ping(text);
    payload.push(performance.now() - at);
  }

  await pool.close();
  const summaryEmpty = summarise(empty.map((value) => value * 1000));
  const summaryPayload = summarise(payload.map((value) => value * 1000));
  // Microseconds internally, milliseconds out: a median of 0 ms tells a reader nothing and
  // reads as "free", which is the conclusion this whole file exists to avoid drawing.
  return { empty: summaryEmpty.medianMs / 1000, payload: summaryPayload.medianMs / 1000 };
}

async function main(): Promise<void> {
  const concurrencies = (
    argv.find((flag) => flag.startsWith('--concurrency='))?.slice('--concurrency='.length) ??
    '16,64,256,1024'
  )
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
  const repeats = Number(
    argv.find((flag) => flag.startsWith('--repeats='))?.slice('--repeats='.length) ?? 3,
  );

  const generated = await generateTree({});
  const found = await discover({ root: generated.root, adapters: ADAPTERS });
  const assetBasenames = basenamesOf(found.assets);
  const files = found.sourceFiles;

  stdout.write(
    [
      '',
      `pool anatomy — ${platform()}, ${cpus().length} cores, ${DEFAULT_POOL_WORKERS} workers`,
      `  ${files.length} source files`,
      '  ⚠️ Check for surviving node processes before trusting this (R49-b).',
      '',
    ].join('\n'),
  );

  // Warm the cache and the JIT for every row alike.
  await scanOnce(files.slice(0, 200), assetBasenames, 16, false);

  // --- 1. The split, at the shipped concurrency. ---------------------------------
  const baseline: number[] = [];
  const pooled: number[] = [];
  const anatomies: ScanPoolAnatomy[] = [];
  for (let repeat = 0; repeat < repeats; repeat++) {
    // Alternating, so drift passes through both sides of every pair (R143).
    if (repeat % 2 === 0) {
      baseline.push((await scanOnce(files, assetBasenames, 16, false)).scanMs);
      const run = await scanOnce(files, assetBasenames, 16, true);
      pooled.push(run.scanMs);
      if (run.anatomy !== null) anatomies.push(run.anatomy);
    } else {
      const run = await scanOnce(files, assetBasenames, 16, true);
      pooled.push(run.scanMs);
      if (run.anatomy !== null) anatomies.push(run.anatomy);
      baseline.push((await scanOnce(files, assetBasenames, 16, false)).scanMs);
    }
  }

  const unpooledSummary = summarise(baseline);
  const pooledSummary = summarise(pooled);
  const median = anatomies[Math.floor((anatomies.length - 1) / 2)];

  stdout.write(
    [
      `  unpooled ${unpooledSummary.medianMs} ms   pooled ${pooledSummary.medianMs} ms   ` +
        `${(((pooledSummary.medianMs - unpooledSummary.medianMs) / Math.max(1, unpooledSummary.medianMs)) * 100).toFixed(1)}%` +
        `   spreads ${unpooledSummary.spreadPercent}/${pooledSummary.spreadPercent}%`,
      '',
    ].join('\n'),
  );

  if (median !== undefined) {
    const idle = median.poolActiveMs * DEFAULT_POOL_WORKERS - median.workerHandlerMs;
    stdout.write(
      [
        '  WHERE THE POOLED RUN WENT — durations, each summed on the side that owns the clock',
        '',
        `    spin-up (to last worker ready) ${Math.round(median.spinUpMs).toString().padStart(7)} ms   ${median.ready}/${DEFAULT_POOL_WORKERS} workers reported`,
        `    pool active (wall)             ${Math.round(median.poolActiveMs).toString().padStart(7)} ms   first dispatch to last result`,
        `    worker parse (occupancy)       ${Math.round(median.workerParseMs).toString().padStart(7)} ms   the work that moved`,
        `    worker handler (occupancy)     ${Math.round(median.workerHandlerMs).toString().padStart(7)} ms   parse + building the reply`,
        `    round trip (occupancy)         ${Math.round(median.roundTripMs).toString().padStart(7)} ms   dispatch to result, main thread`,
        '',
        `    worker-side serialisation      ${Math.round(
          median.workerHandlerMs - median.workerParseMs,
        )
          .toString()
          .padStart(7)} ms   handler − parse`,
        `    transport + queueing           ${Math.round(
          median.roundTripMs - median.workerHandlerMs,
        )
          .toString()
          .padStart(7)} ms   round trip − handler`,
        `    🔴 WORKER IDLE                 ${Math.round(idle).toString().padStart(7)} ms   ${((idle / Math.max(1, median.poolActiveMs * DEFAULT_POOL_WORKERS)) * 100).toFixed(1)}% of available worker time`,
        '',
        `    tasks ${median.tasks}   per worker ${median.perWorkerTasks.join('/')}   busy ${median.perWorkerHandlerMs.map((value) => Math.round(value)).join('/')} ms`,
        '',
        '    ⚠️ These OVERLAP and are not a partition: four workers run at once, so every',
        '       "occupancy" is summed across all of them and only `pool active` is wall clock.',
        '    ⚠️ WORKER IDLE is barrier tails AND waiting for reads, together. The sweep below',
        '       is what separates them — raising `concurrency` removes barriers and nothing else.',
        '',
      ].join('\n'),
    );
  }

  // --- 2. Transport, with the work taken out. ------------------------------------
  const sample = files[Math.floor(files.length / 2)];
  const text = sample === undefined ? '' : await readFile(sample.path, 'utf8');
  const ping = await measurePing(text, 200);
  if (ping !== null && median !== undefined) {
    const predicted = ping.payload * median.tasks;
    stdout.write(
      [
        '  WHAT A ROUND TRIP COSTS WITH NO WORK IN IT — R152 asked for this rather than assuming it',
        '',
        `    empty message      ${ping.empty.toFixed(3)} ms`,
        `    ${(text.length / 1024).toFixed(1)} KB payload    ${ping.payload.toFixed(3)} ms   (the copy is ${(ping.payload - ping.empty).toFixed(3)} ms)`,
        '',
        `    at ${median.tasks} files that predicts ${Math.round(predicted)} ms of transport, one way of`,
        '    looking at it — ⚠️ and it is SERIAL latency, so it is an upper bound on a pipeline',
        '    that overlaps four of them. If the hole is much larger than this, transport is not it.',
        '',
      ].join('\n'),
    );
  }

  // --- 3. The barrier, swept rather than argued. ---------------------------------
  stdout.write(
    [
      '  THE BARRIER BATCH, SWEPT — 7,681 files at 16 per batch is 480 tails (R141 experiment 3)',
      '',
      '    concurrency   unpooled    pooled    change    worker idle',
    ].join('\n'),
  );
  stdout.write('\n');

  for (const concurrency of concurrencies) {
    const left = await scanOnce(files, assetBasenames, concurrency, false);
    const right = await scanOnce(files, assetBasenames, concurrency, true);
    const anatomy = right.anatomy;
    const idle =
      anatomy === null
        ? null
        : anatomy.poolActiveMs * DEFAULT_POOL_WORKERS - anatomy.workerHandlerMs;
    stdout.write(
      [
        String(concurrency).padStart(15),
        `${Math.round(left.scanMs)}`.padStart(11),
        `${Math.round(right.scanMs)}`.padStart(10),
        `${(((right.scanMs - left.scanMs) / Math.max(1, left.scanMs)) * 100).toFixed(1)}%`.padStart(
          10,
        ),
        idle === null ? '          n/a' : `${Math.round(idle)} ms`.padStart(13),
        '\n',
      ].join(''),
    );
  }

  // --- 4. Does adding workers help? If not, the MAIN THREAD is the new bottleneck. ---
  //
  // 🔴 R152 named three candidates. This is the fourth, and it is the one that would make
  // all three fixes pointless: the main thread no longer parses, but it still reads every
  // file, serialises every task and receives every result — and if it is saturated doing
  // that, more workers buy nothing and the pool has simply moved the bottleneck.
  // **Asked as a measurement rather than argued**, because the answer changes which fix is
  // worth building and an inference here is exactly what R136 forbids.
  stdout.write(
    [
      '',
      '  DOES ADDING WORKERS HELP? — if not, the main thread is the bottleneck now',
      '',
      '    workers   pooled    worker idle   parse occupancy',
    ].join('\n'),
  );
  stdout.write('\n');

  for (const count of [1, 2, 4, 8]) {
    const run = await scanOnce(files, assetBasenames, 16, true, count);
    const anatomy = run.anatomy;
    const idle = anatomy === null ? null : anatomy.poolActiveMs * count - anatomy.workerHandlerMs;
    stdout.write(
      [
        String(count).padStart(11),
        `${Math.round(run.scanMs)}`.padStart(9),
        idle === null ? '            n/a' : `${Math.round(idle)} ms`.padStart(15),
        anatomy === null
          ? '              n/a'
          : `${Math.round(anatomy.workerParseMs)} ms`.padStart(18),
        '\n',
      ].join(''),
    );
  }

  // --- 5. Why does the same work cost more CPU in more workers? ---------------------
  //
  // 🔴 The worker sweep above shows total PARSE OCCUPANCY growing with worker count for
  // identical input — the same 7,681 files costing far more worker-CPU at 8 workers than
  // at 1. That is not transport, not a barrier and not spin-up, and none of R152's three
  // candidates predicts it.
  //
  // ⚠️ **The obvious explanation is per-isolate JIT warm-up** — every worker re-optimises
  // parse5, Babel and PostCSS from cold, so splitting the files eight ways means eight
  // partial warm-ups instead of one complete one. **That is an INFERENCE and R136 forbids
  // building on one.** This measures it instead: ONE worker, given fewer and fewer files.
  // If the per-file parse cost rises as the file count falls, warm-up is the cause and the
  // worker count is the lever. If it stays flat, the growth is something else entirely and
  // this hypothesis is dead.
  stdout.write(
    [
      '',
      '  IS IT PER-WORKER WARM-UP? — one worker, fewer files each time',
      '',
      '    files    parse occupancy   ms per file',
    ].join('\n'),
  );
  stdout.write('\n');

  for (const count of [480, 960, 1920, 3840, files.length]) {
    const slice = files.slice(0, count);
    if (slice.length < count) break;
    const run = await scanOnce(slice, assetBasenames, 16, true, 1);
    const anatomy = run.anatomy;
    if (anatomy === null) continue;
    stdout.write(
      [
        String(count).padStart(9),
        `${Math.round(anatomy.workerParseMs)} ms`.padStart(18),
        `${(anatomy.workerParseMs / Math.max(1, anatomy.tasks)).toFixed(3)}`.padStart(14),
        '\n',
      ].join(''),
    );
  }

  stdout.write(
    [
      '',
      '  🔴 ONE PASS PER ROW in the sweep, so read it for SHAPE and not for a number: a row',
      '     that moves less than the pair spread above is not a finding (R142, R143).',
      '  🔴 NO FIX IS BUILT FROM THIS FILE. R152 ruled the split first, then ONE fix aimed at',
      '     the largest share, then a re-measure in CI — and if that does not put the pool',
      '     clearly ahead, §5.1(g) closes as FAILED with the number published.',
      '',
    ].join('\n'),
  );
}

await main();
