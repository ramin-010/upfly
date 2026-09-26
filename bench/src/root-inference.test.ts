/**
 * Whether the root-inference instrument can report a wrong root winning.
 *
 * On the five validation repositories a wrong serving root never outscores the right one,
 * at every volume floor tried, and an instrument that has only seen inputs it gets right
 * has not shown it can disagree. The coverage tree holds the trap: `docs-examples/public`
 * is a directory named `public` that serves nothing.
 *
 * The assertions pin directions, not numbers, because the tree grows: a wrong truth gives a
 * negative gap, the right one a positive gap, and the impostor shows at a low volume floor
 * and is gone at a higher one.
 */

import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { type DirectoryVerdict, type RepoResult, measureRepoAt } from './root-inference.js';

const TREE = join(import.meta.dirname, '..', '..', 'coverage-tree', 'tree');

/** The serving roots the tree's answer key lists: the answer to score against, not an input. */
const TRUTH = ['apps/web/public', 'apps/docs/public', 'sites/root-served', 'legacy/public'];

/**
 * These tests walk and scan the whole coverage tree. One `measureRepoAt` takes about a second
 * on an idle machine and has taken over 5 s under load, past vitest's default timeout, so the
 * tests share the measurements made once in `beforeAll`, under a generous budget.
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

describe('the root-inference instrument can disagree', () => {
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

    // A directory named `public` that serves nothing scores a perfect rate, higher than the
    // genuine roots score on this tree, so a bar made of a resolution rate alone takes it.
    expect(impostor).toBeDefined();
    expect(impostor?.gap).toBeLessThan(0);
    expect(impostor?.bestWrong?.rate).toBe(1);
    expect(impostor?.truthUnreachable).toBe(true);
  });

  it('is excluded by VOLUME, which is what the bar is actually made of', () => {
    // The impostor has two references, so a floor of three drops it, and in every directory
    // that passes the floor a true root ranks first.
    expect(correct.directories.find((v) => v.dir === 'docs-examples/public')?.references).toBe(2);

    const floored = correct.directories.filter((v) => v.references >= 3);
    expect(floored.filter((v) => v.gap < 0)).toHaveLength(0);
    expect(floored.every((v) => v.argmaxCorrect)).toBe(true);
  });
});
