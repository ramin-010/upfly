import { describe, expect, it } from 'vitest';
import { summarise } from './samples.js';

/**
 * The noise gauge's own arithmetic.
 *
 * Small, but the floor it reports decides whether an optimisation is believed, so a
 * spread computed against the wrong denominator would not be a cosmetic defect: it
 * could make a 1% floor out of a 26% one, or the reverse.
 *
 * The gauge's sensitivity is proven separately and not here: `--inject-ms` adds a
 * known delay to a real run and the floor has to move by it. A unit test cannot show
 * that the instrument sees a real change, only that it divides correctly.
 */
describe('the noise gauge’s arithmetic', () => {
  it('reports the median, not the mean, so one outlier cannot move it', () => {
    // The reason `run.ts` quotes a median. A mean of these is 1 964.
    const summary = summarise([1000, 1020, 1040, 1060, 5700]);
    expect(summary.medianMs).toBe(1040);
  });

  it('takes the median of an even sample from the middle pair', () => {
    expect(summarise([100, 200, 300, 400]).medianMs).toBe(250);
  });

  it('measures spread against the median, so the figure is comparable with the record', () => {
    // `run.ts` and `invocations.ts` compute spread the same way and draw their 20% line
    // against it. A spread against the min would read 50% here and compare with neither.
    const summary = summarise([1000, 1200, 1500]);
    expect(summary.minMs).toBe(1000);
    expect(summary.maxMs).toBe(1500);
    expect(summary.spreadPercent).toBe(42); // 500 / 1200
  });

  it('calls a single sample perfectly tight, which is true and is why --cold needs reading', () => {
    // `--cold` takes one sample per process, so every invocation reports 0% internally
    // and only the figure between processes means anything. Reading the internal 0% as
    // stability would have it backwards.
    const summary = summarise([4200]);
    expect(summary.spreadPercent).toBe(0);
    expect(summary.medianMs).toBe(4200);
  });

  it('does not divide by zero when every sample is zero', () => {
    expect(summarise([0, 0]).spreadPercent).toBe(0);
  });

  it('sorts the samples it reports, so the shape is readable rather than arrival order', () => {
    expect(summarise([300, 100, 200]).allMs).toEqual([100, 200, 300]);
  });
});
