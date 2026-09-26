/**
 * That the corpus guard is reached, which is a different claim from the guard working.
 *
 * `repos.test.ts` proves `refuseValidationCorpus` refuses. This proves `optimizeTree`
 * calls it, because a guard nothing calls protects nothing.
 */

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { optimizeTree } from './engine-run.js';
import { VALIDATION_ROOT } from './repos.js';

describe('optimizeTree', () => {
  it('refuses a path inside the pinned corpus before it reads anything', async () => {
    // A directory that does not exist, so that without the guard this rejects on the
    // missing root and still cannot convert a real image. The message tells the two
    // rejections apart.
    const target = join(VALIDATION_ROOT, '__guard-probe-no-such-repository__');

    await expect(optimizeTree(target)).rejects.toThrow(/pinned validation corpus/);
  });
});
