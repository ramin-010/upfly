import type { Manifest, OptimizationPlan } from 'upfly-core';
import { type Asset, buildGraph } from 'upfly-core/internal';
import { describe, expect, it } from 'vitest';
import { count, movingText, renderPlan, writtenByKind } from './plan-text.js';

function asset(relative: string, bytes: number): Asset {
  return { path: `/site/${relative}`, relative, extension: '.png', bytes };
}

const graph = buildGraph({
  root: '/site',
  assets: [asset('images/a.png', 10_000), asset('images/b.png', 4_000)],
  references: [],
  unscannedFiles: [],
});

const plan: OptimizationPlan = {
  conversions: [
    {
      asset: 'images/a.png',
      target: 'images/a.webp',
      format: 'webp',
      quality: 80,
      savedBytes: 7_000,
      replacesOriginal: true,
    },
    {
      asset: 'images/b.png',
      target: 'images/b.webp',
      format: 'webp',
      quality: 'lossless',
      savedBytes: 1_000,
      replacesOriginal: false,
    },
  ],
  rewrites: [
    {
      file: 'index.html',
      edits: [
        { start: 0, end: 12, replacement: 'images/a.webp' },
        { start: 30, end: 42, replacement: 'images/b.webp' },
      ],
    },
  ],
  declined: [],
  keptOriginals: [{ asset: 'images/b.png', reason: 'a pattern still names it' }],
  refusal: null,
};

describe('renderPlan', () => {
  it('lists each conversion with its sizes, each file that changes, and each original', () => {
    expect(renderPlan(plan, graph, 'replace')).toEqual([
      'Plan',
      '',
      '  Convert to WebP: 2 images, 14 KB now and 6 KB after',
      '    images/a.png → images/a.webp  10 KB → 3 KB',
      '    images/b.png → images/b.webp  4 KB → 3 KB',
      '  Update references: 2 references in 1 file',
      '    index.html  2 references',
      '  Remove originals: 1 image, each once every reference to it has moved',
      '    images/a.png',
      '  Keep originals: 1 image, each for its reason',
      '    images/b.png  a pattern still names it',
      '',
    ]);
  });

  it('says each original stays, and how to change that, when originals are kept', () => {
    const kept = { ...plan, keptOriginals: [] };
    expect(renderPlan(kept, graph, 'keep-original').slice(-3)).toEqual([
      '  Originals: each stays beside its converted file, as --keep-originals or the config',
      '  file asks. By default an original is removed once every reference to it has moved.',
      '',
    ]);
  });

  it('says so when there is nothing to do', () => {
    const empty = { ...plan, conversions: [], rewrites: [], keptOriginals: [] };
    expect(renderPlan(empty, graph, 'replace')).toEqual([
      'Plan',
      '',
      '  Nothing to convert and no reference to update.',
      '',
    ]);
  });

  it('lists the first twenty of a long list, keeps every count, and says where the rest are', () => {
    const names = Array.from(
      { length: 25 },
      (_, index) => `images/p${String(index).padStart(2, '0')}`,
    );
    const big = buildGraph({
      root: '/site',
      assets: names.map((name) => asset(`${name}.png`, 2_000)),
      references: [],
      unscannedFiles: [],
    });
    const long: OptimizationPlan = {
      ...plan,
      conversions: names.map((name) => ({
        asset: `${name}.png`,
        target: `${name}.webp`,
        format: 'webp',
        quality: 80,
        savedBytes: 1_500,
        replacesOriginal: false,
      })),
      rewrites: names.map((name) => ({
        file: `${name}.html`,
        edits: [{ start: 0, end: 10, replacement: 'x' }],
      })),
      keptOriginals: [],
    };

    const lines = renderPlan(long, big, 'keep-original');
    const more = '    ... and 5 more; the JSON output, `--json`, lists every one';

    expect(lines).toContain('  Convert to WebP: 25 images, 50 KB now and 12.5 KB after');
    expect(lines).toContain('  Update references: 25 references in 25 files');
    expect(lines.filter((line) => line.includes('.png → '))).toHaveLength(20);
    expect(lines.filter((line) => line.endsWith('.html  1 reference'))).toHaveLength(20);
    expect(lines.filter((line) => line === more)).toHaveLength(2);
  });
});

describe('renderPlan for the report file', () => {
  it('lists every original kept, each with its reason, where the terminal shows twenty', () => {
    const names = Array.from({ length: 25 }, (_, index) => `images/kept-${index + 10}`);
    const big = buildGraph({
      root: '/site',
      assets: names.map((name) => asset(`${name}.png`, 2_000)),
      references: [],
      unscannedFiles: [],
    });
    const keeping: OptimizationPlan = {
      ...plan,
      conversions: names.map((name) => ({
        asset: `${name}.png`,
        target: `${name}.webp`,
        format: 'webp',
        quality: 80,
        savedBytes: 1_500,
        replacesOriginal: false,
      })),
      rewrites: [],
      keptOriginals: names.map((name) => ({ asset: `${name}.png`, reason: 'a pattern names it' })),
    };
    const kept = (lines: readonly string[]) => lines.filter((line) => line.endsWith('names it'));

    expect(kept(renderPlan(keeping, big, 'replace'))).toHaveLength(20);
    expect(kept(renderPlan(keeping, big, 'replace', { everyOriginalKept: true }))).toHaveLength(25);
    expect(renderPlan(keeping, big, 'replace', { everyOriginalKept: true })).toContain(
      '    images/kept-34.png  a pattern names it',
    );
  });
});

describe('writtenByKind', () => {
  it('sorts what a run wrote into created, changed and removed', () => {
    const manifest = {
      operations: [
        { kind: 'create', path: 'images/a.webp', staged: 'staged/images/a.webp', afterHash: 'x' },
        { kind: 'edit', path: 'index.html', beforeHash: 'b', afterHash: 'a', inverse: [] },
        { kind: 'delete', path: 'images/a.png', beforeHash: 'b', backup: 'backup/images/a.png' },
        { kind: 'move', from: 'old/c.png', to: 'new/c.png', hash: 'h' },
      ],
    } as unknown as Manifest;

    expect(writtenByKind(manifest)).toEqual({
      created: ['images/a.webp', 'new/c.png'],
      changed: ['index.html'],
      removed: ['images/a.png', 'old/c.png'],
    });
  });
});

describe('count', () => {
  it('agrees the noun with the number', () => {
    expect([count(0, 'file'), count(1, 'file'), count(2, 'file')]).toEqual([
      '0 files',
      '1 file',
      '2 files',
    ]);
  });
});

describe('movingText', () => {
  it('says whether all, none or some of the references move, in plain words', () => {
    expect(movingText(1, 1, 'to x')).toBe('its 1 reference moves to x');
    expect(movingText(3, 3, 'to x')).toBe('all 3 of its references move to x');
    expect(movingText(0, 1, 'to x')).toBe('its 1 reference stays as written');
    expect(movingText(0, 2, 'to x')).toBe('its 2 references stay as written');
    expect(movingText(1, 2, 'to x')).toBe('1 of its 2 references moves to x');
    expect(movingText(2, 3, 'to x')).toBe('2 of its 3 references move to x');
  });
});
