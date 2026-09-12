/**
 * That the guard is reached, which is a different claim from the guard working.
 *
 * `repos.test.ts` proves `refuseValidationCorpus` refuses. This proves the one
 * function that writes actually calls it, because a guard nothing calls is the decoy
 * shape this project has already been caught by twice, and the proof that a comment
 * does not work is that `validate.ts` ignored one for four days.
 */

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { optimizeTree } from './engine-run.js';
import { VALIDATION_ROOT } from './repos.js';

describe('optimizeTree', () => {
  it('refuses a path inside the pinned corpus before it reads anything', async () => {
    // ⚠️ A directory that does not exist, deliberately. With the guard in place this
    // rejects on the guard. With the guard REMOVED it rejects on `discover` failing to
    // find the root, so the test still cannot convert a real image no matter what is
    // broken. Asserting the message is what tells the two apart: a name-only path
    // inside the corpus would otherwise make this test the very accident it exists to
    // prevent.
    const target = join(VALIDATION_ROOT, '__guard-probe-no-such-repository__');

    await expect(optimizeTree(target)).rejects.toThrow(/pinned validation corpus/);
  });
});
