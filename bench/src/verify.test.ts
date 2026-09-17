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
import type { BrokenFinding, DeadFinding, Mention, PossiblyDeadFinding, Report } from 'upfly-core';
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
  // 🔴 R130's refuting input. This asset is mentioned NOWHERE under its own extension —
  // only as `only%20encoded.jpg`, the same stem under a different one, in a spelling the
  // literal stem lookup cannot match. The honest verdict is `ambiguous`; the defect
  // returned `confirmed-genuine`.
  writeFileSync(join(root, 'img', 'only encoded.png'), 'x');
  // \U0001f534 The source names both assets ONLY in an encoded spelling. That is the input that
  // refutes `verifyDead`, and the corpus no longer supplies it: R118 fixed the ENGINE, so
  // these assets stopped being reported dead and the oracle's copy of the defect went
  // unreachable. The checker owns the input now (R117).
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
  // `unusedVectors` is read unconditionally by `verifyFindings` (R22's demoted
  // assets, which must not fall out of this pass), so the stub carries it.
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

/**
 * R121 — R119's tail, and the expensive half.
 *
 * 🔴 **A false `broken` and a false `dead` are the SAME defect seen from both ends.**
 * A reference that points at nothing, plus a file nobody references — in
 * `railsgirls-com` the engine emitted both, about the same pair, at the same time, and
 * neither instrument noticed the contradiction. `verifyBroken` certified the first as
 * genuine (R119) and `verifyDead` certifies the second, because both look the path up as
 * a string and a string comparison does not decode.
 *
 * ⚠️ **And this direction costs more.** A false `broken` wastes five minutes. A false
 * `dead` tells somebody it is safe to delete a file their site is serving.
 *
 * ⚠️ **Measured before it was fixed: four assets in `railsgirls-com` are named ONLY in
 * an encoded spelling** — `fb baner rails girls.jpg`, `netguru (1).jpg`,
 * `ofiszjal_male_czarne litery.jpg` and `c&s.png`. The corpus can refute this one; it is
 * still pinned here, because R118 fixed the ENGINE and so the corpus no longer reaches the
 * oracle's copy of the defect. **A checker whose only refuting input has been removed by a
 * fix elsewhere is back to confirming (R117).**
 */
describe('verifyDead asks every spelling too', () => {
  it('🔴 calls a percent-spelled mention what it is — the asset is ALIVE', async () => {
    const result = await verifyFindings(root, deadReport('img/hero image.png'), ['']);

    expect(result.items[0]?.verdict).toBe('confirmed-false');
  });

  it('calls an entity-spelled mention what it is', async () => {
    const result = await verifyFindings(root, deadReport('img/a&b.png'), ['']);

    expect(result.items[0]?.verdict).toBe('confirmed-false');
  });

  /**
   * The control, and it is doing real work here: without it an oracle that answered
   * `confirmed-false` to every asset would pass both assertions above.
   */
  it('still calls a genuinely unreferenced asset dead', async () => {
    const result = await verifyFindings(root, deadReport('img/nobody-mentions-me.png'), ['']);

    expect(result.items[0]?.verdict).toBe('confirmed-genuine');
  });

  /**
   * 🔴 **R130 — the same defect one level down, and the branch nobody examined because it
   * looked like the cheap one.**
   *
   * `verifyDead`'s extension-swap branch asked `hitsByStem` for the asset's stem **exactly
   * as it sits on disk**, while R121 taught the branch directly above it to ask in every
   * spelling. So for `img/only encoded.png`, whose only mention in the repository writes
   * `only%20encoded.jpg` — the same name under a different extension, in an encoded
   * spelling — the lookup found nothing.
   *
   * ⚠️ **And the miss does not land on `ambiguous`.** It falls straight through to
   * `confirmed-genuine`, which prints *"no mention of this file anywhere, under any image
   * extension"* about a name the codebase does mention. The branch that produces the
   * softest verdict when it fires was reaching the hardest one when it did not.
   */
  it('🔴 does not certify an asset dead when only an encoded, extension-swapped mention exists', async () => {
    const result = await verifyFindings(root, deadReport('img/only encoded.png'), ['']);

    expect(result.items[0]?.verdict).toBe('ambiguous');
  });
});

/**
 * ⚠️ **`verifyHedge` has the same blind spot pointed the OTHER way, and it is the safe
 * direction — which is exactly why it would have been fixed last.** It asks whether a
 * hedge's citation is real: does the cited file contain the asset's name? A citation
 * pointing at a line that writes `hero%20image.png` found nothing, so the oracle called a
 * perfectly good citation **`confirmed-false`** and failed the gate loudly over an engine
 * that was right. R86's family: a correct engine reported as broken costs somebody an
 * afternoon.
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
