/**
 * `inferServingRoots` has its own tests for its thresholds. These cover what the decision
 * does to inference's input, because both ways this has gone wrong were in the caller: a
 * denominator that counted page links, and a union that could replace a detected root.
 *
 * Every case is synthetic on purpose. The measurement over real repositories is
 * `detect-roots --delta` in `bench/`, and a unit test over one real tree would show only the
 * cases that tree happens to hold.
 */

import { describe, expect, it } from 'vitest';
import { decideServingRoots, looksLikeAsset } from './serving-root-decision.js';
import type { Asset, RawReference, SourceFile, UnscannedFile } from './types.js';

/** An absolute root that looks the same on both platforms, since the code makes it POSIX. */
const ROOT = '/repo';

function asset(relative: string): Asset {
  return { path: `${ROOT}/${relative}`, relative, extension: '.png', bytes: 1 };
}

/** A file an adapter claims, which is how a `package.json` reaches the walk. */
function source(relative: string): SourceFile {
  return { path: `${ROOT}/${relative}`, relative, extension: '.json', adapterId: 'json' };
}

/** A file no adapter claims, which is how a `Gemfile` reaches the walk. */
function unscanned(relative: string): UnscannedFile {
  return {
    path: `${ROOT}/${relative}`,
    relative,
    extension: '',
    reason: 'unclaimed-extension',
    detail: '',
  };
}

/**
 * A walk with no files in it. Detection reads the files beside a `public/`, so a case that
 * is not about that still has to say what the walk held.
 */
const NO_FILES = { sourceFiles: [], unscannedFiles: [] } as const;

function reference(file: string, rawPath: string): RawReference {
  return {
    file: `${ROOT}/${file}`,
    start: 0,
    end: rawPath.length,
    rawPath,
    kind: 'md',
    shape: 'md.image',
    ceiling: 'certain',
    asserted: true,
  };
}

describe('the denominator', () => {
  it('counts only paths that could name an asset', () => {
    expect(looksLikeAsset('/img/hero.png')).toBe(true);
    expect(looksLikeAsset('/img/hero.PNG')).toBe(true);
    expect(looksLikeAsset('/img/hero.png?v=2')).toBe(true);
    expect(looksLikeAsset('/img/hero.png#top')).toBe(true);
    // A page link is a reference the adapter emits and the resolver later drops, so
    // counting it would make it a miss for every candidate.
    expect(looksLikeAsset('/en/guides/deploy/')).toBe(false);
    expect(looksLikeAsset('/about')).toBe(false);
    expect(looksLikeAsset('/styles/site.css')).toBe(false);
  });

  it('finds the serving root a wall of page links would have buried', () => {
    // Three image references `src` resolves among ninety-seven page links. Counting the
    // links, `src` would score 3% and fall under the 40% floor; without them it scores 3/3.
    const references = [
      reference('docs/a.md', '/img/one.png'),
      reference('docs/a.md', '/img/two.png'),
      reference('docs/a.md', '/img/three.png'),
      ...Array.from({ length: 97 }, (_, index) => reference('docs/a.md', `/guides/page-${index}/`)),
    ];

    const decision = decideServingRoots({
      root: ROOT,
      ...NO_FILES,
      directories: ['docs', 'src', 'src/img'],
      assets: [asset('src/img/one.png'), asset('src/img/two.png'), asset('src/img/three.png')],
      references,
    });

    expect(decision.assetReferences).toBe(3);
    expect(decision.added).toEqual(['src']);
    expect(decision.servingRoots.dirs).toContain('src');
  });

  it('reports how many references it scored, because zero looks like nothing to infer', () => {
    const decision = decideServingRoots({
      root: ROOT,
      ...NO_FILES,
      directories: ['src', 'src/img'],
      assets: [asset('src/img/one.png')],
      references: [reference('docs/a.md', '/guides/deploy/')],
    });

    expect(decision.assetReferences).toBe(0);
    expect(decision.added).toEqual([]);
  });
});

describe('the union', () => {
  it('keeps every detected root and adds what inference found', () => {
    const decision = decideServingRoots({
      root: ROOT,
      ...NO_FILES,
      // A `public/` counts only beside a project file, as every real one has.
      sourceFiles: [source('package.json')],
      directories: ['public', 'src', 'src/img'],
      assets: [
        asset('public/logo.png'),
        asset('src/img/one.png'),
        asset('src/img/two.png'),
        asset('src/img/three.png'),
      ],
      references: [
        reference('docs/a.md', '/img/one.png'),
        reference('docs/a.md', '/img/two.png'),
        reference('docs/a.md', '/img/three.png'),
      ],
    });

    // `public` came from its name and `src` from the references.
    expect(decision.detected).toEqual(['public']);
    expect(decision.servingRoots.dirs).toEqual(['public', 'src']);
  });

  it('sorts the union, so the report is the same on every run', () => {
    const decision = decideServingRoots({
      root: ROOT,
      ...NO_FILES,
      sourceFiles: [source('package.json')],
      directories: ['static', 'assets', 'assets/img'],
      assets: [
        asset('static/logo.png'),
        asset('assets/img/one.png'),
        asset('assets/img/two.png'),
        asset('assets/img/three.png'),
      ],
      references: [
        reference('docs/a.md', '/img/one.png'),
        reference('docs/a.md', '/img/two.png'),
        reference('docs/a.md', '/img/three.png'),
      ],
    });
    expect([...decision.servingRoots.dirs]).toEqual([...decision.servingRoots.dirs].sort());
  });

  it('never claims the project declared what was worked out', () => {
    // The report words a declared root and an inferred one differently.
    const decision = decideServingRoots({
      root: ROOT,
      ...NO_FILES,
      sourceFiles: [source('package.json')],
      directories: ['public'],
      assets: [asset('public/logo.png')],
      references: [],
    });
    expect(decision.servingRoots.dirs).toEqual(['public']);
    expect(decision.servingRoots.declared).toBe(false);
  });

  it('hands detection the whole walk, so a project file no adapter claims still counts', () => {
    // A Rails app's project file is its `Gemfile`, which lands in `unscannedFiles`. Passing
    // only the source files would reject every Rails `public/` without a word.
    const decision = decideServingRoots({
      root: ROOT,
      ...NO_FILES,
      unscannedFiles: [unscanned('legacy/Gemfile')],
      directories: ['legacy', 'legacy/public'],
      assets: [asset('legacy/public/plate.png')],
      references: [],
    });
    expect(decision.detected).toEqual(['legacy/public']);
  });
});

describe('what it refuses', () => {
  it('rejects a thin directory that resolves everything it has', () => {
    // A folder named `public` that serves nothing and resolves one reference out of one.
    // A rate-only bar would take it; it has fewer references than the volume floor, so it
    // never gets a rate at all.
    const decision = decideServingRoots({
      root: ROOT,
      ...NO_FILES,
      directories: ['docs-examples', 'docs-examples/public'],
      assets: [asset('docs-examples/public/sample.png')],
      references: [reference('docs-examples/a.md', '/sample.png')],
    });
    expect(decision.added).toEqual([]);
  });

  it('drops a reference from outside the walked tree instead of slicing a wrong path', () => {
    // A negative offset would not throw; it would score a candidate against a filename that
    // exists nowhere.
    const decision = decideServingRoots({
      root: ROOT,
      ...NO_FILES,
      directories: ['src', 'src/img'],
      assets: [asset('src/img/one.png')],
      references: [
        { ...reference('x', '/img/one.png'), file: '/elsewhere/a.md' },
        { ...reference('x', '/img/one.png'), file: '/repo-sibling/a.md' },
      ],
    });
    expect(decision.assetReferences).toBe(0);
  });

  it('does not treat a protocol-relative URL as a root-relative path', () => {
    const decision = decideServingRoots({
      root: ROOT,
      ...NO_FILES,
      directories: ['src', 'src/img'],
      assets: [asset('src/img/one.png')],
      references: [
        reference('a.md', '//cdn.example.com/img/one.png'),
        reference('a.md', '//cdn.example.com/img/two.png'),
        reference('a.md', '//cdn.example.com/img/three.png'),
      ],
    });
    expect(decision.assetReferences).toBe(0);
    expect(decision.added).toEqual([]);
  });
});
