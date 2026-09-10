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
  readonly usable: boolean;
}

/**
 * The same threshold the in-process sampler uses.
 *
 * Not because 20% is principled, but because reporting one kind of disagreement as
 * unusable while quoting the other would be exactly the inconsistency this file
 * exists to remove.
 */
const MAX_SPREAD_PERCENT = 20;

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
    usable: spreadPercent <= MAX_SPREAD_PERCENT,
  };
}
