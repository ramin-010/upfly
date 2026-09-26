/**
 * The oracle has to decode a path before comparing it. `netguru%20(1).jpg` names a file
 * called `netguru (1).jpg`, and a check that compares text as written confirms the false
 * `broken` and false `dead` that an engine with the same blind spot would report.
 *
 * The engine decodes these spellings, so real repositories no longer produce findings that
 * exercise the oracle's decoding. The inputs are written here instead.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrokenFinding, DeadFinding, Mention, PossiblyDeadFinding, Report } from 'upfly-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { verifyFindings } from './verify.js';

let root = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'verify-spelling-'));
  mkdirSync(join(root, 'img'), { recursive: true });
  // Two names that exist on disk only in decoded form. Real files, because the oracle reads
  // a directory rather than a list.
  writeFileSync(join(root, 'img', 'hero image.png'), 'x');
  writeFileSync(join(root, 'img', 'a&b.png'), 'x');
  // Mentioned only as `only%20encoded.jpg`: the same name under another extension, in a
  // spelling the token index cannot hold. The right verdict is `ambiguous`.
  writeFileSync(join(root, 'img', 'only encoded.png'), 'x');
  // The page names each asset only in an encoded spelling.
  writeFileSync(
    join(root, 'page.html'),
    '<img src="./img/hero%20image.png"><img src="./img/a&amp;b.png"><img src="./img/only%20encoded.jpg">',
  );
  writeFileSync(join(root, 'empty.html'), '<p>nothing here</p>');
});

function brokenReport(rawPath: string): Report {
  const finding: BrokenFinding = {
    kind: 'broken',
    file: 'page.html',
    line: 1,
    where: 'page.html:1',
    rawPath,
  };
  // `verifyFindings` also checks `unusedVectors.assets`, so the stub carries it.
  return { findings: [finding], unusedVectors: { assets: [] } } as unknown as Report;
}

function deadReport(asset: string): Report {
  const finding: DeadFinding = { kind: 'dead', asset, bytes: 1, inPublicDir: false };
  return { findings: [finding], unusedVectors: { assets: [] } } as unknown as Report;
}

function hedgeReport(asset: string, where: string): Report {
  const mention: Mention = {
    asset,
    source: 'unresolved-reference',
    where,
    quote: asset,
  } as unknown as Mention;
  const finding: PossiblyDeadFinding = {
    kind: 'possibly-dead',
    asset,
    bytes: 1,
    inPublicDir: false,
    evidence: [mention],
  };
  return { findings: [finding], unusedVectors: { assets: [] } } as unknown as Report;
}

describe('verifyBroken asks every spelling', () => {
  it('calls a percent-encoded path FALSE when it names a file that exists', async () => {
    const result = await verifyFindings(root, brokenReport('./img/hero%20image.png'), ['']);

    expect(result.items[0]?.verdict).toBe('confirmed-false');
    expect(result.items[0]?.evidence.join(' ')).toMatch(/resolves to a file that exists/);
  });

  it('calls an entity-spelled path FALSE when it names a file that exists', async () => {
    const result = await verifyFindings(root, brokenReport('./img/a&amp;b.png'), ['']);

    expect(result.items[0]?.verdict).toBe('confirmed-false');
  });

  /**
   * The control: an oracle that answered `confirmed-false` to everything would pass the
   * two tests above.
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

/**
 * A false `broken` and a false `dead` are one defect seen from both ends: a reference to
 * `hero%20image.png` looks as if it points at nothing, and `hero image.png` looks as if
 * nobody references it. This direction costs more. A false `broken` wastes a few minutes;
 * a false `dead` tells somebody it is safe to delete a file their site serves.
 */
describe('verifyDead asks every spelling too', () => {
  it('calls a percent-spelled mention what it is: the asset is alive', async () => {
    const result = await verifyFindings(root, deadReport('img/hero image.png'), ['']);

    expect(result.items[0]?.verdict).toBe('confirmed-false');
  });

  it('calls an entity-spelled mention what it is', async () => {
    const result = await verifyFindings(root, deadReport('img/a&b.png'), ['']);

    expect(result.items[0]?.verdict).toBe('confirmed-false');
  });

  /**
   * The control: an oracle that answered `confirmed-false` to every asset would pass both
   * tests above.
   */
  it('still calls a genuinely unreferenced asset dead', async () => {
    const result = await verifyFindings(root, deadReport('img/nobody-mentions-me.png'), ['']);

    expect(result.items[0]?.verdict).toBe('confirmed-genuine');
  });

  /**
   * The extension-swap branch has to ask in every spelling too. A miss there does not land
   * on `ambiguous`: it falls through to `confirmed-genuine`, "no mention of this file
   * anywhere, under any image extension", about a name the page does mention.
   */
  it('does not certify an asset dead when only an encoded, extension-swapped mention exists', async () => {
    const result = await verifyFindings(root, deadReport('img/only encoded.png'), ['']);

    expect(result.items[0]?.verdict).toBe('ambiguous');
  });
});

/**
 * The same blind spot in the safe direction. `verifyHedge` checks that a cited file holds
 * the asset's name, and a citation of a line that writes `hero%20image.png` is correct:
 * missing it would report a correct engine as wrong.
 */
describe('verifyHedge asks every spelling too', () => {
  it('accepts a citation whose line writes the name in an encoded spelling', async () => {
    const result = await verifyFindings(root, hedgeReport('img/hero image.png', 'page.html:1'), [
      '',
    ]);

    expect(result.items[0]?.verdict).toBe('confirmed-genuine');
  });

  it('still rejects a citation pointing at a file that does not name the asset', async () => {
    const result = await verifyFindings(root, hedgeReport('img/hero image.png', 'empty.html:1'), [
      '',
    ]);

    expect(result.items[0]?.verdict).toBe('confirmed-false');
  });
});
