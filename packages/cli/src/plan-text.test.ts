import { type Asset, type Manifest, type OptimizationPlan, buildGraph } from 'upfly-core';
import { describe, expect, it } from 'vitest';
import { count, renderPlan, writtenByKind } from './plan-text.js';

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
      '  Originals: each stays beside its converted file. With --replace, an original is',
      '  removed once every reference to it has moved.',
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
