/**
 * The wiring R132 was waiting on, and the two ways it can be wrong without throwing.
 *
 * `inferServingRoots` has its own tests and they cover the bar. What is asserted here is
 * what the CALLER does to its input, because both known failures of this measurement were
 * caller failures rather than algorithm failures:
 *
 * 1. 🔴 **The denominator.** Counting every root-relative reference rather than only the
 *    ones that could name an asset made astro-docs' `public` score **0.1%** and
 *    eleventy-docs' `src` **2.7%**, on repositories where those directories ARE the
 *    serving root. ⚠️ It depressed every candidate equally, so the ranking survived and
 *    only the rates were nonsense.
 * 2. 🔴 **The union.** Inference must ADD to detection and never replace it, and an
 *    accepted root must never be one the volume floor was supposed to reject.
 *
 * ⚠️ **Every case here is synthetic and that is deliberate.** The corpus measurement lives
 * in `detect-roots --delta`, where all five repositories are resolved twice; a unit test
 * that walked a real tree would be slower and would still only show the cases that tree
 * happens to contain (R117).
 */

import type { Asset, RawReference, SourceFile, UnscannedFile } from 'upfly-core';
import { describe, expect, it } from 'vitest';
import { decideServingRoots, looksLikeAsset } from './serving-root-decision.js';

/** An absolute root that looks the same on both platforms, since the code posix-ifies. */
const ROOT = '/repo';

function asset(relative: string): Asset {
  return { path: `${ROOT}/${relative}`, relative, extension: '.png', bytes: 1 };
}

/** A file an adapter claims — how a `package.json` reaches the walk. */
function source(relative: string): SourceFile {
  return { path: `${ROOT}/${relative}`, relative, extension: '.json', adapterId: 'json' };
}

/** A file no adapter claims — how a `Gemfile` reaches the walk. */
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
 * A walk with no files in it. R179's rule reads the files beside a `public/`, so a case
 * that is not about that rule still has to say what the walk held.
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
    // 🔴 The one that caused the 0.1%. A page link is a reference the adapter emits and
    // the resolver drops on the extension rung; counted here it is a miss forever.
    expect(looksLikeAsset('/en/guides/deploy/')).toBe(false);
    expect(looksLikeAsset('/about')).toBe(false);
    expect(looksLikeAsset('/styles/site.css')).toBe(false);
  });

  it('finds the serving root a wall of page links would have buried', () => {
    // Three asset references that `src` resolves, drowned in ninety-seven page links.
    // Without the filter `src` scores 3/100 = 3% and R132's 40% floor rejects it; with
    // it, 3/3. This is eleventy-docs, which really is 11 images among thousands of links.
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

  it('reports the surviving count, because zero looks exactly like nothing to infer', () => {
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
      // R179: a `public/` counts only beside a project file, as every real one does.
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

    // `public` came from the name, `src` from the references. Inference adds; it never
    // takes a detected root away, because the case it exists for is a root detection
    // cannot see, not a root detection got wrong.
    expect(decision.detected).toEqual(['public']);
    expect(decision.servingRoots.dirs).toEqual(['public', 'src']);
  });

  it('sorts the union, because rule 11 promises a byte-identical report', () => {
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

  it('never claims the project declared what we worked out', () => {
    // A run that inferred `src` has been told nothing. `declared: true` would make the
    // report present a guess as a statement, and the report words the two differently.
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

  it('🔴 hands detection the WHOLE walk, so a project file no adapter claims still counts', () => {
    // R179. A Rails app's project file is its `Gemfile`, which no adapter claims: it is in
    // `unscannedFiles`, not `sourceFiles`. A decision that passed only the source files
    // would reject every Rails `public/` without a sound.
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
    // 🔴 `docs-examples/public` in the coverage tree: a directory named `public` that
    // serves nothing and resolves one reference out of one. A rate-only bar takes it and
    // rejects every genuine root, which is R132's finding. Two references is still under
    // MIN_ROOT_REFERENCES, so it never gets a rate at all.
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
    // A negative offset would not throw; it would produce a path starting mid-directory
    // and score a candidate against a filename that does not exist anywhere.
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
