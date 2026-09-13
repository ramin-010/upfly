/**
 * Sample the graph budget across **separate process invocations**.
 *
 * The median-of-five inside one process controls the filesystem cache and nothing
 * else. It was measured doing exactly that: three consecutive invocations reported
 * medians of 4 292 ms (4% internal spread), 5 026 ms (6%) and 5 154 ms (14%) — each
 * internally tight, **17% apart from each other**, against a 5 000 ms gate. The same
 * code passed or failed depending on which invocation you happened to run, and a
 * gate that does that is not a gate.
 *
 * So this spawns `run.js --graph-only --json` N times and reports the spread
 * *between* them as the headline. Process-level variance is what a CI runner
 * actually has, and it is the only figure a gate may be set from.
 *
 * It deliberately does not run the work in-process N times: that would measure the
 * thing already measured. A fresh process is the point — module load, JIT warm-up,
 * a fresh libuv threadpool, and whatever else the OS decides to do differently.
 */

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface InvocationSample {
  /** Each invocation's own median, in the order they ran. */
  readonly medians: readonly number[];
  /** The median of those medians — the number a gate may compare against. */
  readonly medianMs: number;
  readonly minMs: number;
  readonly maxMs: number;
  /** `(max - min) / median` as a percentage, **between** invocations. */
  readonly spreadPercent: number;
  /** Each invocation's internal spread, so the two kinds stay distinguishable. */
  readonly internalSpreadPercent: readonly number[];
  /**
   * Whether these invocations agreed with each other.
   *
   * ⚠️ **Named for what it checks, which is NOT that the number is reproducible.** It was
   * called `usable`, and that name claimed the second thing while measuring the first —
   * measured at 2-9% within a run against 17-22% between runs. A reader who saw
   * `usable: true` had every reason to quote the figure, and quoting it was the mistake.
   */
  readonly samplesAgree: boolean;
}

/**
 * Above this, these invocations disagreed enough that something was wrong with the
 * machine while they ran.
 *
 * 🔴 **MEASURED, and the finding is that the THRESHOLD is right and the AXIS is wrong.**
 * Six CI runs (three per platform) report between-invocation spreads of **2, 3, 3, 3, 4
 * and 9 per cent**. This check has therefore **never fired and essentially cannot**.
 * Meanwhile the headline itself, on unchanged code, moved **3299 → 4022 → 4165 ms on
 * ubuntu (21.5%)** and **4758 → 5233 → 5641 ms on windows (16.9%)** — the same
 * `(max − min) / median` arithmetic, applied *across* runs instead of *within* one,
 * **crosses this very threshold.** 20% was a sensible line drawn against the wrong
 * quantity.
 *
 * ⚠️ **So this is kept as a machine-health check and NOT as a statement that the number
 * is reproducible**, because it cannot be one: between-run drift is invisible from
 * inside a single run, by construction. `samplesAgree` is named for what it actually
 * checks. What protects the gate from drift is **headroom in the budget**, not this.
 */
const MAX_SPREAD_PERCENT = 20;

/**
 * How far the headline moves between CI runs of unchanged code, measured.
 *
 * Printed beside every result so nobody reads a tight within-run spread as a promise of
 * reproducibility. Two independent confirmations: these CI runs, and B6's laptop, where
 * the identical configuration returned 4,761 ms and then 6,012 ms hours apart (26%).
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
