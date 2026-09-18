/**
 * The parse pool: N worker threads, each running the same `parseOne` the main thread runs.
 *
 * ## 🔴 Why it exists, and the number that justifies it
 *
 * CI measured `parse` at **69.4% of `scan`'s wall clock on Windows**, and R141's experiment
 * settled what that meant: stubbing the parse collapsed `read (wall)` by **68.5%**, so the
 * reads were not waiting on a disk — **they were waiting on the main thread** to come back
 * from parsing and collect them. With every main-thread cost removed, `scan` measured
 * **926 ms** and the whole graph build floors at roughly **1,360 ms** against §3.4's
 * 3,000 ms target.
 *
 * ✅ **That floor is the design brief.** There is ~1,600 ms of headroom, so this may spend
 * it on spin-up, cloning and serialisation and still meet the budget. **Correctness first,
 * cleverness never.** Nothing here is optimised beyond the obvious.
 *
 * ## ⚠️ Where it may engage, and why that is not a preference
 *
 * R127 ruled the boundary before this was built: **CLI default, library opt-in.**
 * `upfly-core` runs inside other people's processes — a VS Code extension host, a test
 * runner, an agent — and spawning N OS threads in somebody else's host is a side effect
 * nobody asked for. So `scanSources` pools only when a caller passes `pool`, and the
 * library's default is off. §3.4 already ruled the same way one size down for
 * `UV_THREADPOOL_SIZE`: the CLI owns its process and may; the library asks.
 *
 * **And a pool is a net loss on small inputs.** Worker spin-up is tens of milliseconds
 * each, so a watch-mode rescan of three files must not pay for four of them. R127 requires
 * that floor to be **measured**, not chosen by taste — *"a floor chosen by taste is how
 * `os.cpus() - 1` became a default ~21% worse than 4"*. See `MIN_POOLED_FILES`.
 *
 * ## ✅ Rule 11 survives by construction
 *
 * Output order comes from `scanSources`' existing `Promise.all` over a batch, which
 * preserves **input** order regardless of which task finishes first. This pool changes
 * what happens inside one of those promises and nothing about their arrangement, so the
 * determinism guarantee is untouched — and the barrier batch stays exactly where it was,
 * which is what lets R141's experiment 3 be a separate change later (R134: that line takes
 * one change at a time).
 */

import { Worker } from 'node:worker_threads';
import {
  type ScanPingMessage,
  type ScanTaskMessage,
  type ScanTaskResult,
  WORKER_READY_ID,
} from './scan-worker.js';
import type { ScannedFile } from './scan.js';
import type { SourceFile } from './types.js';

/**
 * How many files make a pool worth spinning up.
 *
 * 🔴 **MEASURED, AND THE NUMBER IS AN ORDER OF MAGNITUDE HIGHER THAN IT LOOKS LIKE IT
 * SHOULD BE.** `bench/src/pool-floor.ts` sweeps pooled against unpooled, alternating within
 * each pair so drift passes through both sides (R143). On one laptop, over the generated
 * tree, median of three:
 *
 * | files | unpooled | pooled | change | |
 * |---|---|---|---|---|
 * | 400 | 756 | 1 791 | **+136.9%** | pool loses badly |
 * | 1 600 | 3 242 | 4 297 | **+32.5%** | still losing |
 * | 3 200 | 6 249 | 6 855 | **+9.7%** | still losing |
 * | 4 000 | 7 778 | 7 663 | −1.5% | inside the spread — break-even |
 * | 6 400 | 11 854 | 10 424 | **−12.1%** | winning, outside a 7% spread |
 * | 7 681 | 15 295 | 12 124 | **−20.7%** | winning, outside a 9% spread |
 *
 * **So the floor is where it stops LOSING, not where it starts winning**, which is the
 * conservative half: below this it is measurably worse and there is no argument for
 * engaging. ⚠️ **Worker spin-up is ~500 ms of it and the rest is the barrier batch** —
 * `scanSources` still syncs every 16 files, so the pool can never have more than 16 tasks
 * outstanding. R141's experiment 3 is that batch, and this measurement says it is not
 * merely the next lever, it is what caps this one.
 *
 * 🔴 **THE CONSEQUENCE NOBODY SHOULD HAVE TO DERIVE: no repository in the validation
 * corpus reaches this floor.** `shadcn-ui` is the largest at 5,406 source files. **On every
 * real repository we measure, the pool does not engage at all** — the number that justifies
 * it is the 7,681-file generated tree §3.4's budget is set on.
 *
 * ⚠️ **One laptop under 39–63% background load (R124), so DIRECTIONAL.** CI is the
 * instrument and the floor moves when CI runs this sweep — never from a laptop alone.
 */
export const MIN_POOLED_FILES = 4_000;

/** How many workers, when the caller does not say. */
export const DEFAULT_POOL_WORKERS = 4;

export interface ScanPoolOptions {
  /**
   * Worker count. Defaults to `DEFAULT_POOL_WORKERS`.
   *
   * ⚠️ **Not `os.cpus() - 1`.** §3.4 records that default measuring ~21% worse than 4 for
   * the encode pool, and guessing the same way twice is how that happened the first time.
   */
  readonly workers?: number;
  /** Below this many files the pool does not engage. Defaults to `MIN_POOLED_FILES`. */
  readonly minFiles?: number;
}

/** Why the scan did or did not use a pool. Reported, never silent. */
export type ScanPoolReason =
  /** The caller did not ask. This is the library default (R127). */
  | 'not-requested'
  /** Fewer files than the floor, so spin-up would have cost more than it saved. */
  | 'below-floor'
  /** A caller-supplied adapter a worker cannot import. See `scan-worker.ts`. */
  | 'custom-adapter'
  /** Workers could not be started here. The scan ran on the main thread and is correct. */
  | 'unavailable'
  | 'engaged';

export interface ScanPoolReport {
  readonly engaged: boolean;
  readonly reason: ScanPoolReason;
  /** Workers actually started. Zero unless `engaged`. */
  readonly workers: number;
  /**
   * Files the pool handed back to the main thread because a worker failed on them.
   *
   * 🔴 **Printed even when zero.** A pool that quietly dropped files would produce a
   * repository with no references in it and no error, which is rule 9's P0 exactly.
   */
  readonly fellBack: number;
  /**
   * Where the pooled scan's time went. Absent when no pool ran.
   *
   * 🔴 **Reported rather than kept for a profiler**, because R152's question — which of
   * spin-up, transport and barrier-tail idling the pool's unexplained milliseconds are —
   * has to be answerable from a CI log. CI is the only instrument that can settle it on
   * the machine §3.4's budget is set on.
   */
  readonly anatomy?: ScanPoolAnatomy;
}

/**
 * Where a pooled scan's wall clock actually went.
 *
 * 🔴 **R152 ruled ONE MEASUREMENT AND NO FIX**, because three candidate causes and one
 * unmeasured number is how a week disappears. CI measured the pool 31.7% SLOWER than the
 * main thread — `scan` 4,075 → 5,366 ms — with parse at 0 ms on the main thread and reads
 * down 77%. **The physics is right; the plumbing costs more than the physics saves**, and
 * about 4,400 ms of the pooled run is machinery of an unmeasured kind.
 *
 * ⚠️ **Every field here is a DURATION summed on the side that owns the clock.** Worker
 * threads each have their own `performance.timeOrigin`, so a worker's instant and the main
 * thread's instant are measured from different zeroes; subtracting them would produce a
 * decomposition that is confidently wrong and flags nothing.
 *
 * ⚠️ **The sums OVERLAP and are not a partition** — the same mistake the read/parse
 * breakdown was built to prevent, at a smaller scale. Four workers run at once, so
 * `workerHandlerMs` is occupancy across all of them and only `poolActiveMs` is wall clock.
 */
export interface ScanPoolAnatomy {
  /**
   * Pool construction until the LAST worker reported it had finished loading.
   *
   * A `new Worker` returns immediately; parse5, Babel, PostCSS and every adapter load
   * afterwards, while the main thread is already queueing tasks nobody is reading.
   */
  readonly spinUpMs: number;
  /** Workers that announced themselves. Fewer than `workers` means one never loaded. */
  readonly ready: number;
  readonly tasks: number;
  /** First dispatch to last result. The only wall-clock figure here. */
  readonly poolActiveMs: number;
  /** Summed `dispatch → result` on the main thread. Occupancy across all workers. */
  readonly roundTripMs: number;
  /** Summed time inside `parseOne`, reported by the workers. The work that moved. */
  readonly workerParseMs: number;
  /** Summed whole-handler time. `handler - parse` is the workers' own serialisation. */
  readonly workerHandlerMs: number;
  /** Per worker, so an idle or overloaded one is visible rather than averaged away. */
  readonly perWorkerHandlerMs: readonly number[];
  readonly perWorkerTasks: readonly number[];
}

export interface ScanPool {
  run(file: SourceFile, text: string): Promise<ScannedFile | null>;
  /**
   * One round trip carrying `text`, doing no work at all.
   *
   * 🔴 **The measurement R152 named and refused to assume.** With an empty string this is
   * pure latency; with a real file's text it is latency plus the copy, and the difference
   * is the copy. Nothing can separate those two while a parse is still in the message.
   */
  ping(text: string): Promise<void>;
  /** Files a worker could not do, which the caller re-parsed on the main thread. */
  readonly fellBack: number;
  readonly workers: number;
  readonly anatomy: ScanPoolAnatomy;
  close(): Promise<void>;
}

/**
 * Start a pool, or return `null` if workers cannot be started here.
 *
 * ⚠️ **`null` rather than a throw.** A host that forbids worker threads is a reason to scan
 * on the main thread, not a reason to fail an audit — the answer is identical either way,
 * only slower. The caller records `unavailable` so the choice is visible.
 */
export function createScanPool(
  workerCount: number,
  assetBasenames: ReadonlySet<string> | undefined,
  /**
   * The worker module. A parameter so the dead-worker path can be TESTED rather than
   * reasoned about — point it at a module that throws on load and every task must come
   * back `null` instead of hanging. It is not on `ScanPoolOptions`: this is a seam for
   * the pool's own tests, not a knob for callers.
   */
  workerUrl: URL = new URL('./scan-worker.js', import.meta.url),
): ScanPool | null {
  const basenames = assetBasenames === undefined ? [] : [...assetBasenames];

  const workers: Worker[] = [];
  try {
    for (let index = 0; index < workerCount; index++) {
      workers.push(
        new Worker(workerUrl, {
          workerData: { assetBasenames: basenames },
          // 🔴 **Not the parent's flags.** `new Worker` inherits `execArgv` by default, so
          // a host started with `--input-type=module`, an experimental loader, or any flag
          // that is meaningless for a worker kills every worker at startup — and R127's
          // whole point is that `upfly-core` runs inside other people's processes. Found
          // by a worker dying with `--input-type can only be used with string input`,
          // which had nothing to do with this package.
          execArgv: [],
        }),
      );
    }
  } catch {
    // Started some but not all: tear down rather than run a half pool, whose only effect
    // would be to make the engagement floor describe something that was never measured.
    for (const worker of workers) void worker.terminate();
    return null;
  }

  interface Pending {
    readonly resolve: (value: ScannedFile | null) => void;
    readonly reject: (reason: unknown) => void;
  }
  const pending = new Map<number, Pending>();
  /** Which worker owns each in-flight task, so one worker's death only affects its own. */
  const owner = new Map<number, Worker>();
  const dead = new Set<Worker>();
  let nextId = 0;
  let fellBack = 0;
  let closed = false;

  // --- R153's anatomy. Accounting only; it changes no dispatch decision. -------------
  const createdAt = performance.now();
  const dispatchedAt = new Map<number, number>();
  const index = new Map<Worker, number>(workers.map((worker, at) => [worker, at]));
  let spinUpMs = 0;
  let ready = 0;
  let tasks = 0;
  let firstDispatchAt = 0;
  let lastResultAt = 0;
  let roundTripMs = 0;
  let workerParseMs = 0;
  let workerHandlerMs = 0;
  const perWorkerHandlerMs = workers.map(() => 0);
  const perWorkerTasks = workers.map(() => 0);

  /**
   * A worker died. Hand its in-flight tasks back and stop routing to it.
   *
   * 🔴 **THE BUG THIS EXISTS FOR IS A HANG, WHICH IS WORSE THAN A CRASH.** `postMessage`
   * to a dead worker throws nothing and delivers nothing, so without the `dead` set every
   * task round-robin later sent to it would sit unresolved forever — and the symptom is
   * an audit that never returns, with no error anywhere. Rejecting only the *currently*
   * pending tasks is not enough: the ones posted afterwards are the ones that hang.
   *
   * ⚠️ Resolving `null` rather than rejecting, because the caller's answer to `null` is to
   * parse the file on the main thread. A rejection would be caught and do the same thing;
   * `null` says the same thing without pretending a failure happened to the FILE.
   */
  const bury = (worker: Worker): void => {
    if (dead.has(worker)) return;
    dead.add(worker);
    for (const [id, owning] of owner) {
      if (owning !== worker) continue;
      const waiting = pending.get(id);
      owner.delete(id);
      pending.delete(id);
      if (waiting !== undefined) {
        fellBack++;
        waiting.resolve(null);
      }
    }
  };

  for (const worker of workers) {
    worker.on('message', (result: ScanTaskResult) => {
      // A worker announcing it has finished loading. Recorded every time, because the
      // LAST one is what spin-up cost — the pool is only as started as its slowest member.
      if (result.id === WORKER_READY_ID) {
        ready++;
        spinUpMs = performance.now() - createdAt;
        return;
      }

      const waiting = pending.get(result.id);
      if (waiting === undefined) return;
      pending.delete(result.id);
      owner.delete(result.id);

      const now = performance.now();
      const sentAt = dispatchedAt.get(result.id);
      dispatchedAt.delete(result.id);
      if (sentAt !== undefined) {
        roundTripMs += now - sentAt;
        lastResultAt = now;
      }
      workerParseMs += result.parseMs;
      workerHandlerMs += result.handlerMs;
      const at = index.get(worker);
      if (at !== undefined) {
        perWorkerHandlerMs[at] = (perWorkerHandlerMs[at] ?? 0) + result.handlerMs;
        perWorkerTasks[at] = (perWorkerTasks[at] ?? 0) + 1;
      }

      if (result.workerError !== null) fellBack++;
      waiting.resolve(result.scanned);
    });

    worker.on('error', () => bury(worker));
    worker.on('exit', () => {
      if (!closed) bury(worker);
    });
  }

  // Round robin rather than a free-worker queue. The tasks are the same shape and within
  // a factor of a few of the same size, so the cheapest scheduler is the right one until a
  // measurement says otherwise — and one that tracks idleness is a second place for a
  // dropped task to hide.
  let cursor = 0;

  return {
    run(file: SourceFile, text: string): Promise<ScannedFile | null> {
      // Only live workers. Round robin over a list that includes a corpse is how the
      // hang above happened, and `null` here means "parse it on the main thread", which
      // is always available and always correct.
      const alive = workers.filter((worker) => !dead.has(worker));
      const worker = alive[cursor % Math.max(1, alive.length)];
      cursor++;
      if (worker === undefined) {
        fellBack++;
        return Promise.resolve(null);
      }

      const id = nextId++;
      return new Promise<ScannedFile | null>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        owner.set(id, worker);
        try {
          const at = performance.now();
          if (firstDispatchAt === 0) firstDispatchAt = at;
          dispatchedAt.set(id, at);
          tasks++;
          worker.postMessage({ id, file, text } satisfies ScanTaskMessage);
        } catch {
          // It died between the liveness check and the post.
          pending.delete(id);
          owner.delete(id);
          fellBack++;
          resolve(null);
        }
      });
    },
    /**
     * One round trip with no work in it.
     *
     * Serial by construction — the caller awaits each one — because a latency measured
     * while four of them are in flight is a measurement of the queue, not of the trip.
     */
    ping(text: string): Promise<void> {
      const alive = workers.filter((worker) => !dead.has(worker));
      const worker = alive[0];
      if (worker === undefined) return Promise.resolve();

      const id = nextId++;
      return new Promise<void>((resolve) => {
        pending.set(id, { resolve: () => resolve(), reject: () => resolve() });
        owner.set(id, worker);
        worker.postMessage({ id, ping: true, text } satisfies ScanPingMessage);
      });
    },
    get fellBack() {
      return fellBack;
    },
    workers: workers.length,
    get anatomy(): ScanPoolAnatomy {
      return {
        spinUpMs,
        ready,
        tasks,
        // Zero until something has come back, rather than a negative number from an
        // uninitialised pair — a decomposition that reports nonsense for an empty run is
        // one nobody trusts on a full one.
        poolActiveMs: lastResultAt === 0 ? 0 : lastResultAt - firstDispatchAt,
        roundTripMs,
        workerParseMs,
        workerHandlerMs,
        perWorkerHandlerMs: [...perWorkerHandlerMs],
        perWorkerTasks: [...perWorkerTasks],
      };
    },
    async close(): Promise<void> {
      closed = true;
      await Promise.all(workers.map((worker) => worker.terminate()));
    },
  };
}
