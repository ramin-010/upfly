/**
 * Median and spread over a set of timings.
 *
 * A library module rather than part of `noise.ts`, following the convention the rest of
 * `bench/` already uses: `invocations.ts` and `triage.ts` are importable, entry points
 * carry a top-level `main()`. A test that imported the entry point would run it.
 *
 * `run.ts`'s `sample()` and `invocations.ts` still compute the same median and spread
 * inline, and all three agree. Folding those two into this one changes the arithmetic
 * under the CI gate, so it belongs in a change of its own, with the gate's output
 * compared before and after.
 */

export interface Summary {
  /** The number to quote. Not the mean: one outlier moves a mean. */
  readonly medianMs: number;
  readonly minMs: number;
  readonly maxMs: number;
  /**
   * `(max - min) / median`, as a percentage.
   *
   * Against the median rather than the min, so the figure compares directly with the 20%
   * line that `run.ts` and `invocations.ts` draw with the same arithmetic. A spread
   * against the min reads higher and compares with neither.
   */
  readonly spreadPercent: number;
  /** Every sample, sorted, so a reader sees the shape rather than trusting the summary. */
  readonly allMs: readonly number[];
}

export function summarise(times: readonly number[]): Summary {
  const sorted = [...times].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const medianMs =
    sorted.length % 2 === 0
      ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
      : (sorted[middle] ?? 0);
  const minMs = sorted[0] ?? 0;
  const maxMs = sorted[sorted.length - 1] ?? 0;

  return {
    medianMs: Math.round(medianMs),
    minMs: Math.round(minMs),
    maxMs: Math.round(maxMs),
    spreadPercent: medianMs === 0 ? 0 : Math.round(((maxMs - minMs) / medianMs) * 100),
    allMs: sorted.map((value) => Math.round(value)),
  };
}
