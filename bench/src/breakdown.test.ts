/**
 * The sampled breakdown's arithmetic, and the one invariant its conclusion rests on.
 *
 * The experiment subtracts one variant's `scan` from another's, so the variants must
 * differ in exactly one thing. If stubbing the parse also changed which files `discover`
 * claimed, the difference would be the cost of scanning fewer files, read as the cost of
 * parsing: a wrong answer that looks exactly like the right one. That invariant is
 * asserted here against a real tree. The rest is the arithmetic that decides whether a
 * step's movement is believed, and since a guard that never fires proves nothing, every
 * verdict branch has a test that reaches it, including the two that say no.
 */

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type Breakdown,
  EXPERIMENT_1,
  MAX_STEP_SPREAD_PERCENT,
  VARIANTS,
  type Variant,
  measureBreakdown,
  renderBreakdown,
  renderExperiment,
  rotate,
  summariseBreakdowns,
} from './breakdown.js';

const TREE = join(import.meta.dirname, '..', '..', 'coverage-tree', 'tree');

/**
 * Real filesystem work, and vitest's default timeout is 5 s.
 *
 * `root-inference.test.ts` runs over the same tree in about 0.5 to 1.1 s idle and has
 * taken over 5 s under load. A test here makes up to three full passes over it, with no
 * warm-up discarded since this is a correctness test, not a measurement.
 */
const FILESYSTEM_TIMEOUT_MS = 60_000;

function pass(overrides: Partial<Breakdown> = {}): Breakdown {
  return {
    variant: 'baseline',
    discoverMs: 100,
    scanMs: 5_000,
    resolveMs: 200,
    graphMs: 50,
    readMs: 4_700,
    readOccupancyMs: 40_000,
    parseMs: 3_500,
    parseByExtension: [['.tsx', 1_000]],
    adapterThrows: 0,
    files: 7_681,
    references: 18_434,
    ...overrides,
  };
}

describe('the variants differ in exactly one thing', () => {
  it(
    'claims the same files whether or not the parse is stubbed',
    async () => {
      const measured = new Map<Variant, Breakdown>();
      for (const variant of EXPERIMENT_1)
        measured.set(variant, await measureBreakdown(TREE, variant));

      const counts = new Set([...measured.values()].map((breakdown) => breakdown.files));
      // The whole experiment is `scan(baseline) - scan(no-parse)`. If these disagree,
      // that subtraction is measuring a different amount of work and nothing printed
      // beneath it means anything. The stub keeps `id` and `extensions` for this reason.
      expect(counts.size).toBe(1);
      expect([...counts][0]).toBeGreaterThan(0);
    },
    FILESYSTEM_TIMEOUT_MS,
  );

  it(
    'returns references at baseline and none once the parse is stubbed',
    async () => {
      const baseline = await measureBreakdown(TREE, 'baseline');
      const stubbed = await measureBreakdown(TREE, 'no-parse');

      // The stub scans every file and returns no references. A non-zero count here would
      // mean an adapter was missed and part of the parse was still running inside the
      // "no parse" number.
      expect(baseline.references).toBeGreaterThan(0);
      expect(stubbed.references).toBe(0);
      expect(stubbed.parseMs).toBeLessThan(baseline.parseMs);
    },
    FILESYSTEM_TIMEOUT_MS,
  );

  it(
    'still measures the read window when nothing is parsed',
    async () => {
      // `readMs` is the union of intervals with a read outstanding. A stubbed parse must
      // not make it zero, or the read-wall comparison between the two variants would
      // compare a number against nothing.
      const stubbed = await measureBreakdown(TREE, 'no-parse');
      expect(stubbed.readMs).toBeGreaterThan(0);
      expect(stubbed.readOccupancyMs).toBeGreaterThanOrEqual(stubbed.readMs);
    },
    FILESYSTEM_TIMEOUT_MS,
  );
});

describe('rotation, so no variant is always measured first', () => {
  it('starts each child at a different variant', () => {
    expect(rotate(['a', 'b', 'c'], 0)).toEqual(['a', 'b', 'c']);
    expect(rotate(['a', 'b', 'c'], 1)).toEqual(['b', 'c', 'a']);
    expect(rotate(['a', 'b', 'c'], 2)).toEqual(['c', 'a', 'b']);
  });

  it('keeps rotating past the end and takes an empty list without throwing', () => {
    expect(rotate(['a', 'b', 'c'], 4)).toEqual(['b', 'c', 'a']);
    expect(rotate([], 3)).toEqual([]);
  });
});

describe('the per-step summary', () => {
  it('summarises each step independently, because they do not move together', () => {
    const sample = summariseBreakdowns([
      pass({ scanMs: 5_000, parseMs: 3_500 }),
      pass({ scanMs: 5_100, parseMs: 3_900 }),
      pass({ scanMs: 5_050, parseMs: 3_600 }),
    ]);

    expect(sample.scan.medianMs).toBe(5_050);
    expect(sample.parse.medianMs).toBe(3_600);
    // 100/5050 = 2%, against 400/3600 = 11%. Real runs have shown exactly this: `scan` and
    // `parse` moving by different amounts and in opposite directions over one commit.
    expect(sample.scan.spreadPercent).toBe(2);
    expect(sample.parse.spreadPercent).toBe(11);
  });

  it('marks a step UNUSABLE when its own samples disagree, and only that step', () => {
    const sample = summariseBreakdowns([
      pass({ scanMs: 5_000, graphMs: 50 }),
      pass({ scanMs: 5_050, graphMs: 90 }),
      pass({ scanMs: 5_020, graphMs: 60 }),
    ]);

    // 40/60 = 67%, far above the threshold. A 60 ms step cannot resolve a 10% change,
    // and saying so is the whole point of printing a per-step spread.
    expect(sample.graph.spreadPercent).toBeGreaterThan(MAX_STEP_SPREAD_PERCENT);
    expect(sample.unusableSteps).toEqual(['graph']);
    expect(renderBreakdown(sample)).toContain('UNUSABLE');
  });

  it('says nothing is unusable when every step agrees with itself', () => {
    const sample = summariseBreakdowns([pass(), pass({ scanMs: 5_010 }), pass({ scanMs: 4_990 })]);
    expect(sample.unusableSteps).toEqual([]);
  });

  it('takes parse-by-extension from the median pass, not from an average of passes', () => {
    // An averaged breakdown describes an execution that never happened. The median pass
    // by `scan` is a real one, which is what a reader chasing a regression needs.
    const sample = summariseBreakdowns([
      pass({ scanMs: 4_000, parseByExtension: [['.fast', 1]] }),
      pass({ scanMs: 5_000, parseByExtension: [['.median', 2]] }),
      pass({ scanMs: 9_000, parseByExtension: [['.slow', 3]] }),
    ]);
    expect(sample.parseByExtension).toEqual([['.median', 2]]);
  });

  it('keeps every distinct file count, so a changed tree cannot pass unnoticed', () => {
    const sample = summariseBreakdowns([pass({ files: 7_681 }), pass({ files: 7_600 })]);
    expect(sample.fileCounts).toEqual([7_681, 7_600]);
    expect(renderBreakdown(sample)).toContain('THE PASSES SAW DIFFERENT TREES');
  });

  it('refuses an empty set rather than reporting zeroes for it', () => {
    // Returning a breakdown of zeroes would print a 0 ms `parse` and read as a finding.
    expect(() => summariseBreakdowns([])).toThrow();
  });
});

describe('what every breakdown says about itself', () => {
  it('prints that its spread is not the attribution floor, on every run', () => {
    // A tight spread inside one run says nothing about drift between runs, which this
    // instrument cannot see. So it says so unconditionally, not only when the spread
    // happens to be wide.
    const rendered = renderBreakdown(summariseBreakdowns([pass(), pass(), pass()]));
    expect(rendered).toContain('WITHIN this run');
    expect(rendered).toContain('NOT the');
  });

  it('points at the experiment block only when the run prints one', () => {
    const sample = summariseBreakdowns([pass()]);
    expect(renderBreakdown(sample, true)).toContain('which is what the experiment block below is');
    expect(renderBreakdown(sample)).not.toContain('experiment block below');
    expect(renderBreakdown(sample)).toContain('which `--experiments` adds to this output');
  });

  it('says what its failure count counts', () => {
    const rendered = renderBreakdown(summariseBreakdowns([pass()]));
    expect(rendered).toContain('files an adapter could not parse: 0');
    expect(rendered).not.toContain('(R86)');
  });

  it('keeps the warning that read-wall and parse overlap and must not be added', () => {
    const rendered = renderBreakdown(summariseBreakdowns([pass()]));
    expect(rendered).toContain('OVERLAP');
    expect(rendered).toContain('Do not add them');
  });
});

/** The named variants at a chosen `scan`, everything else held still. */
function experimentAt(scans: Partial<Record<Variant, readonly number[]>>) {
  return VARIANTS.filter((variant) => scans[variant] !== undefined).map((variant) =>
    summariseBreakdowns(
      (scans[variant] ?? []).map((scanMs) => pass({ variant, scanMs, readMs: scanMs - 100 })),
    ),
  );
}

describe('what the experiment block concludes', () => {
  it('splits scan into parse, the mention pass and everything else', () => {
    const rendered = renderExperiment(
      experimentAt({
        baseline: [10_000, 10_100, 10_050],
        'no-parse': [4_000, 4_050, 4_020],
        'no-parse-no-mentions': [3_000, 3_050, 3_010],
      }),
    );

    // 10 050 − 4 020 = 6 030 parse · 4 020 − 3 010 = 1 010 mentions · 3 010 floor.
    expect(rendered).toContain('6030 ms  60.0% of scan');
    expect(rendered).toContain('1010 ms  10.0% of scan');
    // 60.0 + 10.0 + 30.0 = 100.0. They sum because they are a partition, the same
    // quantity under three treatments, which read-wall and parse are not.
    expect(rendered).toContain('3010 ms  30.0% of scan');
  });

  it('calls the main thread the bottleneck when parse dominates scan', () => {
    const rendered = renderExperiment(
      experimentAt({
        baseline: [10_000, 10_010, 10_020],
        'no-parse': [3_000, 3_010, 3_020],
        'no-parse-no-mentions': [2_500, 2_510, 2_520],
      }),
    );
    expect(rendered).toContain('MAIN THREAD');
  });

  it('says the parse is the wrong target when parse is a minority of scan', () => {
    // This branch must be reachable, or the instrument can only ever point at the parse.
    const rendered = renderExperiment(
      experimentAt({
        baseline: [10_000, 10_010, 10_020],
        'no-parse': [8_000, 8_010, 8_020],
        'no-parse-no-mentions': [7_800, 7_810, 7_820],
      }),
    );
    expect(rendered).toContain('threadpool or the read strategy');
    expect(rendered).not.toContain('MAIN THREAD');
  });

  it('refuses a verdict when the difference is inside the variants’ own spread', () => {
    // 10 000 → 9 800 is 2.0%, and these passes disagree with themselves by 20%. A move
    // inside the noise is not a finding, however it prints.
    const rendered = renderExperiment(
      experimentAt({
        baseline: [9_000, 10_000, 11_000],
        'no-parse': [8_800, 9_800, 10_800],
        'no-parse-no-mentions': [8_700, 9_700, 10_700],
      }),
    );
    expect(rendered).toContain('VERDICT: NONE');
    expect(rendered).not.toContain('MAIN THREAD');
  });

  it('prints nothing at all when the variants it needs were not run', () => {
    // The default CI invocation samples the baseline only. An experiment block rendered
    // from one variant would be a subtraction against a missing operand.
    expect(renderExperiment([summariseBreakdowns([pass()])])).toBe('');
  });
});

describe('one pass is not a floor', () => {
  it('refuses to place experiment 1’s verdict against a single draw', () => {
    // `summarise([x])` reports 0% spread, which is true and is not a floor.
    // `noise.test.ts` records the same trap on the same arithmetic.
    const rendered = renderExperiment(
      experimentAt({ baseline: [10_000], 'no-parse': [4_000], 'no-parse-no-mentions': [3_000] }),
    );
    expect(rendered).toContain('ONE pass');
    expect(rendered).not.toContain('MAIN THREAD');
  });
});
