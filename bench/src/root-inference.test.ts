/**
 * Can the R71 instrument return **no**?
 *
 * 🔴 **R128 rests on this file.** The five validation repositories produced *zero* cases
 * where a wrong serving root outscored the right one, at every volume floor tested — and
 * a zero from an instrument that has only ever seen inputs it gets right is not a result,
 * it is an instrument that agrees (R117). The coverage tree is the corpus built to hold
 * traps, and it holds the one that matters here: **`docs-examples/public` is a directory
 * named `public` that serves nothing.**
 *
 * ⚠️ **Until now that demonstration was a command somebody had to remember to run.** It is
 * an assertion now, so it runs on every `pnpm check` and a change that quietly made the
 * instrument incapable of disagreeing would fail here instead of being discovered by the
 * next person who happened to re-read the ruling.
 *
 * ⚠️ **These assertions are about the instrument's BEHAVIOUR, not about the exact numbers
 * in R128.** A gap of −78.9 points is a fact about today's coverage tree, and the tree is
 * meant to grow (R110). What must not change is the direction: a wrong truth must come
 * back negative, the right truth must come back positive, and the impostor must be
 * visible at a low volume floor and gone at a higher one.
 */

import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { type DirectoryVerdict, type RepoResult, measureRepoAt } from './root-inference.js';

const TREE = join(import.meta.dirname, '..', '..', 'coverage-tree', 'tree');

/** The key's own serving roots. Used as the ANSWER to score against, never as input. */
const TRUTH = ['apps/web/public', 'apps/docs/public', 'sites/root-served', 'legacy/public'];

/**
 * 🔴 **These tests do real filesystem work and vitest's default timeout is 5 s.**
 *
 * Measured: one `measureRepoAt` over the coverage tree costs ~0.5–1.1 s idle, and **5,069
 * ms under load** — which is how it failed once in the pre-commit hook while passing in
 * isolation and in a full `pnpm check` minutes earlier. A test that sits at 94% of its
 * timeout is not passing, it is waiting to flake, and a flaky gate trains `[wip]`, which
 * kills the gate while the suite still looks protected.
 *
 * Two fixes, both preferred to raising the limit alone: the three tests that ask the same
 * question share one measurement, and what remains carries an explicit, generous budget
 * that says out loud this is a measurement rather than a unit test.
 */
const BUDGET_MS = 60_000;

let correct: RepoResult;
let wrong: RepoResult;

beforeAll(async () => {
  correct = await measureRepoAt(TREE, 'coverage-tree', TRUTH, false);
  wrong = await measureRepoAt(TREE, 'coverage-tree', [''], false);
}, BUDGET_MS);

function weightedGap(directories: readonly DirectoryVerdict[]): number {
  const references = directories.reduce((sum, verdict) => sum + verdict.references, 0);
  if (references === 0) return 0;
  return directories.reduce((sum, v) => sum + v.gap * v.references, 0) / references;
}

describe('the R71 instrument can disagree', () => {
  it('🔴 returns a NEGATIVE gap when handed a truth that is wrong', () => {
    // The project root serves nothing in this tree; its real roots are four directories
    // below it. If this comes back positive the instrument is not measuring anything.
    expect(wrong.references).toBeGreaterThan(0);
    expect(weightedGap(wrong.directories)).toBeLessThan(0);
    expect(wrong.directories.filter((v) => v.argmaxCorrect)).toHaveLength(0);
  });

  it('returns a POSITIVE gap when handed the right one', () => {
    expect(weightedGap(correct.directories)).toBeGreaterThan(0);
  });
});

describe('the impostor the acceptance bar exists to reject', () => {
  it('🔴 `docs-examples/public` beats every true root on its own references', () => {
    const impostor = correct.directories.find((v) => v.dir === 'docs-examples/public');

    // A directory named `public` that serves nothing, scoring perfectly — which is why
    // an acceptance bar phrased as a RESOLUTION RATE takes it and rejects the genuine
    // roots, whose rates on this tree run 45.8% to 80.0%.
    expect(impostor).toBeDefined();
    expect(impostor?.gap).toBeLessThan(0);
    expect(impostor?.bestWrong?.rate).toBe(1);
    expect(impostor?.truthUnreachable).toBe(true);
  });

  it('is excluded by VOLUME, which is what the bar is actually made of', () => {
    // Measured: the impostor carries 2 references, and at a floor of 3 the two
    // populations separate completely — every true root above 45%, every wrong one at 0.
    expect(correct.directories.find((v) => v.dir === 'docs-examples/public')?.references).toBe(2);

    const floored = correct.directories.filter((v) => v.references >= 3);
    expect(floored.filter((v) => v.gap < 0)).toHaveLength(0);
    expect(floored.every((v) => v.argmaxCorrect)).toBe(true);
  });
});
