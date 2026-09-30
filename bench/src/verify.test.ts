/**
 * The oracle has to decode a path before comparing it. `netguru%20(1).jpg` names a file
 * called `netguru (1).jpg`, and a check that compares text as written confirms the false
 * `broken` and false `dead` that an engine with the same blind spot would report.
 *
 * The engine decodes these spellings, so real repositories no longer produce findings that
 * exercise the oracle's decoding. The inputs are written here instead.
 */

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrokenFinding, DeadFinding, PossiblyDeadFinding, Report } from 'upfly-core';
import { DEFAULT_IGNORED_DIRECTORIES } from 'upfly-core/internal';
import type { Mention } from 'upfly-core/internal';
import { beforeAll, describe, expect, it } from 'vitest';
import { ORACLE_SKIPS, verifyFindings } from './verify.js';

let root = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'verify-spelling-'));
  mkdirSync(join(root, 'img'), { recursive: true });
  // Two names that exist on disk only in decoded form. Real files, because the oracle reads
  // a directory rather than a list.
  writeFileSync(join(root, 'img', 'hero image.png'), 'x');
  writeFileSync(join(root, 'img', 'a&b.png'), 'x');
  writeFileSync(join(root, 'img', 'my_photo.png'), 'x');
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

function brokenReport(rawPath: string, file = 'page.html'): Report {
  const finding: BrokenFinding = {
    kind: 'broken',
    file,
    line: 1,
    where: `${file}:1`,
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
  it('calls a percent-encoded path false when it names a file that exists', async () => {
    const result = await verifyFindings(root, brokenReport('./img/hero%20image.png'), ['']);

    expect(result.items[0]?.verdict).toBe('confirmed-false');
    expect(result.items[0]?.evidence.join(' ')).toMatch(/resolves to a file that exists/);
  });

  it('calls an entity-spelled path false when it names a file that exists', async () => {
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
    const result = await verifyFindings(root, brokenReport('./img/caf&eacut;.png'), ['']);

    expect(result.items[0]?.verdict).toBe('confirmed-genuine');
  });

  it.each(['./img/a&#38;b.png', './img/a&#x26;b.png'])(
    'reads %s whole, since its # belongs to a character reference',
    async (path) => {
      const result = await verifyFindings(root, brokenReport(path), ['']);

      expect(result.items[0]?.verdict).toBe('confirmed-false');
    },
  );

  it('still cuts the path at a real fragment', async () => {
    const result = await verifyFindings(root, brokenReport('./img/nothing.png#frag'), ['']);

    expect(result.items[0]?.verdict).toBe('confirmed-genuine');
  });

  it('reads a Markdown escape where the finding sits in Markdown, and nowhere else', async () => {
    // In a Markdown destination `my\_photo.png` names `my_photo.png`; in HTML the
    // backslash is part of the name. The kind comes from the file, not from the finding.
    const path = './img/my\\_photo.png';
    const inMarkdown = await verifyFindings(root, brokenReport(path, 'guide.md'), ['']);
    const inHtml = await verifyFindings(root, brokenReport(path), ['']);

    expect(inMarkdown.items[0]?.verdict).toBe('confirmed-false');
    expect(inHtml.items[0]?.verdict).toBe('confirmed-genuine');
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

/**
 * Names in any script, and a name written partly percent-encoded. A browser asks for
 * `Рисунок2.png` whole, and a server decodes `Zaječar%20(2).jpg` to `Zaječar (2).jpg`. An oracle
 * that read neither would call a correct engine wrong.
 */
describe('the oracle reads a name as the browser and the server do', () => {
  let site = '';

  beforeAll(() => {
    site = mkdtempSync(join(tmpdir(), 'verify-scripts-'));
    mkdirSync(join(site, 'images', 'lviv'), { recursive: true });
    writeFileSync(join(site, 'images', '2.png'), 'x');
    writeFileSync(join(site, 'images', 'lviv', 'Рисунок2.png'), 'x');
    writeFileSync(join(site, 'images', 'Zaječar (2).jpg'), 'x');
    writeFileSync(join(site, 'lviv.html'), '<img src="./images/lviv/Рисунок2.png">\n');
    writeFileSync(
      join(site, 'zajecar.html'),
      '<meta content="https://example.org/images/Zaječar%20(2).jpg">\n',
    );
  });

  it('does not read the end of a longer name in another script as the name', async () => {
    const result = await verifyFindings(site, deadReport('images/2.png'), ['']);

    expect(result.items[0]?.verdict).toBe('confirmed-genuine');
  });

  it('accepts a citation whose line writes the name partly percent-encoded', async () => {
    const report = hedgeReport('images/Zaječar (2).jpg', 'zajecar.html:1');
    const result = await verifyFindings(site, report, ['']);

    expect(result.items[0]?.verdict).toBe('confirmed-genuine');
  });
});

describe('a name the token pattern cannot hold is searched for literally', () => {
  // `photo(1).png` holds parentheses, which the oracle's token pattern stops at, so only its
  // literal search can see the mention.
  function site(): string {
    const own = mkdtempSync(join(tmpdir(), 'verify-literal-'));
    mkdirSync(join(own, 'img'), { recursive: true });
    writeFileSync(join(own, 'img', 'photo(1).png'), 'x');
    writeFileSync(join(own, 'notes.txt'), 'See img/photo(1).png for the picture.');
    return own;
  }

  it('calls a dead finding false when a file names the image', async () => {
    const result = await verifyFindings(site(), deadReport('img/photo(1).png'), ['']);

    expect(result.items[0]?.verdict).toBe('confirmed-false');
  });

  it('confirms a hedge whose evidence is that mention', async () => {
    const result = await verifyFindings(site(), hedgeReport('img/photo(1).png', 'notes.txt:1'), [
      '',
    ]);

    expect(result.items[0]?.verdict).toBe('confirmed-genuine');
  });
});

describe('the oracle skips every folder the engine prunes', () => {
  // A mention in generated output or in Upfly's own records is no use of the image: it
  // would make a correct dead finding look false.
  it.each(['.astro/data-store.json', '.upfly/manifest.json'])(
    'does not let a mention in %s call a correct dead finding false',
    async (mention) => {
      const own = mkdtempSync(join(tmpdir(), 'verify-pruned-'));
      mkdirSync(join(own, 'img'), { recursive: true });
      writeFileSync(join(own, 'img', 'lonely.png'), 'x');
      mkdirSync(join(own, dirname(mention)), { recursive: true });
      writeFileSync(join(own, mention), '{ "image": "lonely.png" }');

      const result = await verifyFindings(own, deadReport('img/lonely.png'), ['']);

      expect(result.items[0]?.verdict).toBe('confirmed-genuine');
    },
  );

  it('holds every name the engine prunes', () => {
    for (const name of DEFAULT_IGNORED_DIRECTORIES) {
      expect([name, ORACLE_SKIPS.has(name)]).toEqual([name, true]);
    }
  });
});

/** Permission bits do nothing on Windows, and root reads a directory whatever its mode. */
const cannotDropPermissions = process.platform === 'win32' || process.getuid?.() === 0;

describe('the oracle says what it could not read', () => {
  it.skipIf(cannotDropPermissions)(
    'records a directory it cannot list, with the reason',
    async () => {
      // The only mention of the image sits in the directory the oracle cannot list, so a dead
      // verdict would rest on it, and the list of what went unread has to say so.
      const own = mkdtempSync(join(tmpdir(), 'verify-locked-'));
      mkdirSync(join(own, 'img'), { recursive: true });
      mkdirSync(join(own, 'locked'), { recursive: true });
      writeFileSync(join(own, 'img', 'lonely.png'), 'x');
      writeFileSync(join(own, 'locked', 'notes.txt'), 'uses lonely.png');
      chmodSync(join(own, 'locked'), 0o000);
      try {
        const result = await verifyFindings(own, deadReport('img/lonely.png'), ['']);

        expect(result.unreadable).toEqual([expect.stringMatching(/^locked\/: EACCES/)]);
      } finally {
        chmodSync(join(own, 'locked'), 0o755);
      }
    },
  );
});
