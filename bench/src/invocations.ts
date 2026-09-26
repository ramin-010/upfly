/**
 * Sample the graph budget across separate process invocations.
 *
 * The median of several runs inside one process controls the filesystem cache and
 * nothing else. Invocations that each agree closely with themselves can still land far
 * enough apart to pass or fail the same code, so this spawns `run.js --graph-only --json`
 * N times and reports the spread between them. A fresh process is the point: module
 * load, JIT warm-up, a fresh libuv threadpool, and whatever else the OS does differently.
 * See "The gate is a regression ceiling, not the target" in ARCHITECTURE.md.
 */

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface InvocationSample {
  /** Each invocation's own median, in the order they ran. */
  readonly medians: readonly number[];
  /** The median of those medians, which is the number compared with the ceiling. */
  readonly medianMs: number;
  readonly minMs: number;
  readonly maxMs: number;
  /** `(max - min) / median` as a percentage, between invocations. */
  readonly spreadPercent: number;
  /** Each invocation's internal spread, so the two kinds stay distinguishable. */
  readonly internalSpreadPercent: readonly number[];
  /**
   * Whether these invocations agreed with each other.
   *
   * It does not mean the number will reproduce; `MAX_SPREAD_PERCENT` says why.
   */
  readonly samplesAgree: boolean;
}

/**
 * Above this, these invocations disagreed enough that something was wrong with the
 * machine while they ran.
 *
 * A machine-health check, and it cannot be more. In CI, the invocations of one run differ
 * by 2 to 9%, while the headline drifts 17 to 22% between runs of unchanged code, which
 * is invisible from inside a single run. Headroom in the ceiling is what absorbs that
 * drift, not this check.
 */
const MAX_SPREAD_PERCENT = 20;

/**
 * How far the headline moves between runs of unchanged code, measured.
 *
 * Printed beside every result so nobody reads a tight within-run spread as a promise of
 * reproducibility. The developer-machine figure is one configuration measured twice,
 * hours apart: 4,761 ms and then 6,012 ms.
 */
export const MEASURED_BETWEEN_RUN_DRIFT = '17–22% in CI, 26% on a developer machine';

export async function sampleAcrossInvocations(
  count: number,
  runsEach: number,
): Promise<InvocationSample> {
  const script = fileURLToPath(new URL('run.js', import.meta.url));
  const medians: number[] = [];
  const internal: number[] = [];

  for (let index = 0; index < count; index++) {
    const { stdout } = await run(
      process.execPath,
      [script, '--graph-only', '--json', `--runs=${runsEach}`],
      // A big tree's JSON is well under this, but a truncated buffer would surface
      // as a JSON parse error blamed on the wrong thing.
      { maxBuffer: 32 * 1024 * 1024 },
    );

    const parsed = JSON.parse(stdout) as {
      graphBudget: { totalMs: number; sample: { spreadPercent: number } };
    };
    medians.push(parsed.graphBudget.totalMs);
    internal.push(parsed.graphBudget.sample.spreadPercent);
  }

  const sorted = [...medians].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const medianMs =
    sorted.length % 2 === 0
      ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
      : (sorted[middle] ?? 0);
  const minMs = sorted[0] ?? 0;
  const maxMs = sorted[sorted.length - 1] ?? 0;
  const spreadPercent = medianMs === 0 ? 0 : Math.round(((maxMs - minMs) / medianMs) * 100);

  return {
    medians,
    medianMs: Math.round(medianMs),
    minMs: Math.round(minMs),
    maxMs: Math.round(maxMs),
    spreadPercent,
    internalSpreadPercent: internal,
    samplesAgree: spreadPercent <= MAX_SPREAD_PERCENT,
  };
}
