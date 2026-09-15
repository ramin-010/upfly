/**
 * R119 — the oracle shared the engine's blind spot, and this is the test that would
 * have caught it.
 *
 * 🔴 **`verifyBroken` looked the path up exactly as written**, so
 * `images/lodz/2015/netguru%20(1).jpg` missed a real file called `netguru (1).jpg` — and
 * its basename fallback missed it too, for the same reason. It then returned
 * **`confirmed-genuine` with evidence attached**, which is worse than returning nothing:
 * the run printed *"None came back false"* over 1,886 adjudicated findings while four of
 * them were false, on the one criterion the product is sold on.
 *
 * ⚠️ **R117, and this file is the repair.** The corpus could confirm *zero false broken*
 * and could not refute it, because the only inputs that would have refuted it were ones
 * the engine and the oracle mis-read the same way. The case is now an INPUT the checker
 * owns rather than something we hope a repository happens to contain.
 *
 * ⚠️ **An oracle that shares the mechanism it checks is not an oracle.** This one was
 * built to avoid exactly that — its own directory index, its own grep, never the engine —
 * and it reproduced the defect anyway, because *not decoding* is the default behaviour of
 * any string comparison. Independence of implementation is not independence of assumption.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrokenFinding, Report } from 'upfly-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { verifyFindings } from './verify.js';

let root = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'verify-spelling-'));
  mkdirSync(join(root, 'img'), { recursive: true });
  // The two names that only exist DECODED. Written as real files, because the oracle
  // reads a directory rather than a list.
  writeFileSync(join(root, 'img', 'hero image.png'), 'x');
  writeFileSync(join(root, 'img', 'a&b.png'), 'x');
  writeFileSync(join(root, 'page.html'), 'x');
});

function brokenReport(rawPath: string): Report {
  const finding: BrokenFinding = {
    kind: 'broken',
    file: 'page.html',
    line: 1,
    where: 'page.html:1',
    rawPath,
  };
  // `unusedVectors` is read unconditionally by `verifyFindings` (R22's demoted
  // assets, which must not fall out of this pass), so the stub carries it.
  return { findings: [finding], unusedVectors: { assets: [] } } as unknown as Report;
}

describe('verifyBroken asks every spelling', () => {
  it('🔴 calls a percent-encoded path FALSE when it names a file that exists', async () => {
    const result = await verifyFindings(root, brokenReport('./img/hero%20image.png'), ['']);

    expect(result.items[0]?.verdict).toBe('confirmed-false');
    expect(result.items[0]?.evidence.join(' ')).toMatch(/resolves to a file that exists/);
  });

  it('calls an entity-spelled path FALSE when it names a file that exists', async () => {
    const result = await verifyFindings(root, brokenReport('./img/a&amp;b.png'), ['']);

    expect(result.items[0]?.verdict).toBe('confirmed-false');
  });

  /**
   * The control. Without it, an oracle that answered `confirmed-false` to everything
   * would pass the two assertions above — which is the shape of B9's mutation proof that
   * could not fail.
   */
  it('still calls a genuinely missing path genuine', async () => {
    const result = await verifyFindings(root, brokenReport('./img/nothing%20here.png'), ['']);

    expect(result.items[0]?.verdict).toBe('confirmed-genuine');
  });

  it('and an undecodable spelling is still judged on its literal text alone', async () => {
    const result = await verifyFindings(root, brokenReport('./img/caf&eacute;.png'), ['']);

    expect(result.items[0]?.verdict).toBe('confirmed-genuine');
  });
});
