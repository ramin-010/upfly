import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defaultAdapters } from './adapters/default-adapters.js';
import { audit } from './audit.js';
import { discover } from './discover.js';
import { findDuplicates, hashCandidates } from './duplicates.js';
import { buildGraph } from './graph.js';
import type { Asset } from './types.js';

/**
 * `duplicate` — assets shipping the same pixels more than once (§1.1).
 *
 * 🔴 **The correction this finding exists under is Rinkal's own: group by CONTENT
 * HASH, never by name.** His site holds a 0.9 MB pair — `programoffered.webp` and
 * `sideimage-gurkirt.webp` — whose names have nothing in common, so a name-based check
 * misses it entirely. There is a test below that fails against a name-based
 * implementation and passes against this one, in both directions.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures');

function asset(relative: string, bytes: number): Asset {
  return {
    path: `/repo/${relative}`,
    relative,
    extension: relative.slice(relative.lastIndexOf('.')),
    bytes,
  };
}

describe('which assets are worth reading', () => {
  it('reads only the ones whose size another asset shares', () => {
    // 🔴 **Two byte-identical files must have the same size**, so an asset with a
    // unique size cannot be a duplicate and never needs to be opened. This is what
    // makes the check cheap in fact rather than in the spec's assumption that "the
    // bytes are already read" — nothing in the pipeline reads asset bytes today.
    const assets = [asset('a.png', 100), asset('b.png', 100), asset('c.png', 999)];

    expect(hashCandidates(assets).map((entry) => entry.relative)).toEqual(['a.png', 'b.png']);
  });

  it('ignores empty files, which are all identical and all uninteresting', () => {
    // True and useless. A repository with forty empty placeholders would otherwise
    // produce one enormous set that buries every real one.
    const assets = [asset('a.png', 0), asset('b.png', 0), asset('c.png', 5), asset('d.png', 5)];

    expect(hashCandidates(assets).map((entry) => entry.relative)).toEqual(['c.png', 'd.png']);
  });
});

describe('grouping by content, never by name', () => {
  it('groups two files whose names have nothing in common', () => {
    // 🔴 The measured case: `programoffered.webp` and `sideimage-gurkirt.webp`, 0.9 MB,
    // identical bytes. A name-based check finds nothing here.
    const assets = [
      asset('programoffered.webp', 900_000),
      asset('sideimage-gurkirt.webp', 900_000),
    ];
    const hashes = new Map([
      ['programoffered.webp', 'same'],
      ['sideimage-gurkirt.webp', 'same'],
    ]);

    expect(findDuplicates(assets, hashes)).toEqual([
      {
        hash: 'same',
        assets: ['programoffered.webp', 'sideimage-gurkirt.webp'],
        bytes: 900_000,
        wastedBytes: 900_000,
      },
    ]);
  });

  it('does NOT group two files that merely share a name', () => {
    // The other direction, and the half that a name-based implementation passes. Both
    // together are what pin the rule: same name and different bytes is two images,
    // different names and same bytes is one.
    const assets = [asset('a/logo.png', 500), asset('b/logo.png', 500)];
    const hashes = new Map([
      ['a/logo.png', 'one'],
      ['b/logo.png', 'two'],
    ]);

    expect(findDuplicates(assets, hashes)).toEqual([]);
  });

  it('counts what keeping one copy would recover, not what the set occupies', () => {
    // ⚠️ One copy has to survive, so `bytes × copies` would offer a saving that cannot
    // be taken — the same defect as quoting an encode saving that needs the original
    // deleted to be real.
    const assets = [asset('a.png', 100), asset('b.png', 100), asset('c.png', 100)];
    const hashes = new Map([
      ['a.png', 'x'],
      ['b.png', 'x'],
      ['c.png', 'x'],
    ]);

    const [set] = findDuplicates(assets, hashes);
    expect(set?.assets).toHaveLength(3);
    expect(set?.wastedBytes).toBe(200);
  });

  it('orders by what is worth recovering, and breaks ties deterministically', () => {
    const assets = [
      asset('small-a.png', 10),
      asset('small-b.png', 10),
      asset('big-a.png', 900),
      asset('big-b.png', 900),
    ];
    const hashes = new Map([
      ['small-a.png', 's'],
      ['small-b.png', 's'],
      ['big-a.png', 'b'],
      ['big-b.png', 'b'],
    ]);

    expect(findDuplicates(assets, hashes).map((set) => set.wastedBytes)).toEqual([900, 10]);
  });

  it('says nothing about an asset that was never hashed', () => {
    // An asset absent from the map is one nothing could have matched — its size was
    // unique — rather than one we failed to check. Reporting it would be inventing.
    const assets = [asset('a.png', 100), asset('unique.png', 7)];

    expect(findDuplicates(assets, new Map([['a.png', 'x']]))).toEqual([]);
  });
});

describe('on a real tree', () => {
  /** Hash every candidate for real, the way a caller would. */
  async function duplicatesIn(fixture: string) {
    const discovered = await discover({ root: join(FIXTURES, fixture), adapters: defaultAdapters });
    const assets = [...discovered.assets];
    const hashes = new Map<string, string>();

    for (const candidate of hashCandidates(assets)) {
      hashes.set(
        candidate.relative,
        createHash('sha256')
          .update(await readFile(candidate.path))
          .digest('hex'),
      );
    }

    return { sets: findDuplicates(assets, hashes), assets, hashed: hashes.size };
  }

  it('finds the placeholder set in eleventy, whose names have nothing in common', async () => {
    // ✅ **A real duplicate set that was already there.** `IMAGE-CREDITS.md` records that
    // the fixtures once held 70-byte placeholders; five survive in `eleventy/src/img/`
    // under five unrelated names. Nothing about `favicon`, `inline`, `templated`,
    // `texture` and `unused` suggests they are the same file, and they are.
    const { sets } = await duplicatesIn('eleventy');

    expect(sets).toHaveLength(1);
    expect(sets[0]?.assets).toEqual([
      'src/img/favicon.png',
      'src/img/inline.png',
      'src/img/templated.png',
      'src/img/texture.png',
      'src/img/unused.png',
    ]);
    expect(sets[0]?.bytes).toBe(70);
    expect(sets[0]?.wastedBytes).toBe(280);
  });

  it('reaches the REPORT in recoverable-bytes order, not path order', async () => {
    // 🔴 **The bug that a findDuplicates-only test could not see.** The sets were
    // sorted correctly and then re-sorted by the audit's report order, so `scratch-www`
    // rendered 562 B, then 2.5 KB, then 136.4 KB. Found by reading the rendered report,
    // which is the fourth wording-or-ordering defect this phase that no test caught.
    //
    // Asserted through `audit` rather than `findDuplicates`, because the defect lived
    // entirely between them.
    const discovered = await discover({
      root: join(FIXTURES, 'eleventy'),
      adapters: defaultAdapters,
    });
    const graph = buildGraph({
      root: discovered.root,
      assets: discovered.assets,
      references: [],
      unscannedFiles: [],
    });
    // ⚠️ **The names make path order and waste order DISAGREE, and that is the whole
    // test.** The first version used `small-*` and `big-*`, where `big` sorts first
    // alphabetically as well as by size — so it passed against the unfixed code and the
    // mutation stayed green. Third time this session that a test could not see its own
    // premise; here the premise is that the two orders differ.
    const hashes = new Map([
      ['a-tiny-one.png', 'tiny'],
      ['a-tiny-two.png', 'tiny'],
      ['z-huge-one.png', 'huge'],
      ['z-huge-two.png', 'huge'],
    ]);
    const withSizes = buildGraph({
      root: '/repo',
      assets: [
        asset('a-tiny-one.png', 10),
        asset('a-tiny-two.png', 10),
        asset('z-huge-one.png', 9_000),
        asset('z-huge-two.png', 9_000),
      ],
      references: [],
      unscannedFiles: [],
    });

    const result = await audit({
      graph: withSizes,
      sweep: { mentions: new Map(), skipped: [] },
      readFile: async () => '',
      contentHashes: hashes,
    });
    const sets = result.findings.filter((finding) => finding.kind === 'duplicate');

    expect(sets.map((set) => (set.kind === 'duplicate' ? set.wastedBytes : 0))).toEqual([
      9_000, 10,
    ]);
    expect(graph.assets.length).toBeGreaterThan(0);
  });

  it('opens far fewer files than the tree holds', async () => {
    // The cheapness claim, measured rather than asserted. If this ever equalled the
    // asset count the size pre-filter would have stopped working and every audit would
    // have gained a full extra read of every image.
    const { assets, hashed } = await duplicatesIn('eleventy');

    expect(hashed).toBeLessThan(assets.length);
  });
});
