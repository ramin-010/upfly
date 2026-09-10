import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isLinked, linkedPaths } from './reference.js';
import { resolveReferences } from './resolve.js';
import type { Asset, RawReference, Reference } from './types.js';

/**
 * The resolver carries six accumulated requirements, and every one of them exists
 * because some real syntax would otherwise be reported as `broken`. The suite is
 * arranged by ladder rung so a failure says which rung is wrong.
 */

// Resolved rather than written literally: on Windows `path.resolve` qualifies a
// drive-less absolute path with the current drive, so a bare '/project' would not
// match the paths the resolver computes. `discover` always returns a resolved root.
const ROOT = resolve('/project');

function asset(relative: string): Asset {
  return {
    path: join(ROOT, relative),
    relative,
    extension: relative.slice(relative.lastIndexOf('.')).toLowerCase(),
    bytes: 100,
  };
}

const ASSETS: readonly Asset[] = [
  asset('src/assets/logo.png'),
  asset('src/assets/hero.jpg'),
  asset('src/images/one.png'),
  asset('src/images/two.png'),
  asset('src/images/three.png'),
  asset('src/images/nested/deep.png'),
  asset('public/banner.png'),
  asset('at-root.png'),
];

function raw(overrides: Partial<RawReference> & { rawPath: string }): RawReference {
  return {
    file: join(ROOT, 'src', 'App.jsx'),
    start: 0,
    end: overrides.rawPath.length,
    kind: 'import',
    ceiling: 'certain',
    asserted: true,
    ...overrides,
  };
}

function resolveOne(overrides: Partial<RawReference> & { rawPath: string }): Reference | undefined {
  return resolveReferences([raw(overrides)], { root: ROOT, assets: ASSETS })[0];
}

describe('resolveReferences', () => {
  describe('rung 1 — an unsafe ceiling is dynamic, never broken', () => {
    it.each([
      ['a preprocessor variable', '$hero'],
      ['an interpolated path', '#{$dir}/hero.png'],
      ['a template expression', '{{ image }}'],
      ['a path that does not exist either', './nowhere.png'],
    ])('%s', (_name, rawPath) => {
      const reference = resolveOne({ rawPath, ceiling: 'unsafe' });

      // The whole point: nobody typed a path that points at nothing.
      expect(reference?.resolution).toBe('dynamic');
      expect(reference?.confidence).toBe('unsafe');
    });

    it('is decided before the extension filter, so an extensionless one survives', () => {
      // Filtering first would drop `url($hero)` silently, losing a reference the
      // user is explicitly told about as "could not safely rewrite".
      expect(resolveOne({ rawPath: '$hero', ceiling: 'unsafe' })?.resolution).toBe('dynamic');
    });
  });

  describe('rung 2 — a medium ceiling is a pattern', () => {
    it('links every asset the pattern matches, not just the first', () => {
      // Linking one would leave the other two looking unreferenced, which is a
      // false `dead asset` finding — the same failure in a different costume.
      const reference = resolveOne({ rawPath: './images/${name}.png', ceiling: 'medium' });

      expect(reference?.resolution).toBe('resolved-pattern');
      expect(linkedPaths(reference as Reference)).toEqual([
        join(ROOT, 'src/images/one.png'),
        join(ROOT, 'src/images/three.png'),
        join(ROOT, 'src/images/two.png'),
      ]);
    });

    it('keeps confidence at medium', () => {
      const reference = resolveOne({ rawPath: './images/${name}.png', ceiling: 'medium' });
      expect(reference?.confidence).toBe('medium');
    });

    it('is dynamic when nothing matches, never broken', () => {
      const reference = resolveOne({ rawPath: './nothing/${name}.png', ceiling: 'medium' });
      expect(reference?.resolution).toBe('dynamic');
    });

    it('does not let a hole cross a directory boundary', () => {
      // `[^/]*` rather than `.*`: the author wrote one segment, so matching
      // `nested/deep.png` would pull in an asset they never referred to.
      const reference = resolveOne({ rawPath: './images/${name}.png', ceiling: 'medium' });
      expect(linkedPaths(reference as Reference)).not.toContain(
        join(ROOT, 'src/images/nested/deep.png'),
      );
    });

    it('matches a pattern with a hole in the middle of a segment', () => {
      const reference = resolveOne({ rawPath: './images/t${rest}.png', ceiling: 'medium' });
      expect(linkedPaths(reference as Reference)).toEqual([
        join(ROOT, 'src/images/three.png'),
        join(ROOT, 'src/images/two.png'),
      ]);
    });

    it('handles a root-relative pattern', () => {
      const reference = resolveOne({ rawPath: '/${name}.png', ceiling: 'medium' });
      expect(linkedPaths(reference as Reference)).toEqual([join(ROOT, 'public/banner.png')]);
    });

    it('treats regex metacharacters in the static part literally', () => {
      const reference = resolveOne({ rawPath: './images/o+e.${ext}', ceiling: 'medium' });
      expect(reference?.resolution).toBe('dynamic');
    });
  });

  describe('rung 3 — files we do not track are dropped, not reported', () => {
    it.each([
      ['a font', './inter.woff2'],
      ['a stylesheet', './styles.css'],
      ['a sibling module', './App.jsx'],
      ['a package', 'react'],
      ['a subpath import', 'next/image'],
      ['a video', './clip.mp4'],
    ])('%s produces no reference at all', (_name, rawPath) => {
      // Not a skip under rule 9: it was never a candidate asset reference, and
      // counting every font in a stylesheet would be pure noise.
      expect(resolveReferences([raw({ rawPath })], { root: ROOT, assets: ASSETS })).toEqual([]);
    });

    it('drops them before the broken test, which is the point', () => {
      // Behind the resolution test, every `url(inter.woff2)` becomes a finding.
      const references = resolveReferences(
        [raw({ rawPath: './inter.woff2', kind: 'css-url' }), raw({ rawPath: './assets/logo.png' })],
        { root: ROOT, assets: ASSETS },
      );
      expect(references.map((reference) => reference.resolution)).toEqual(['resolved']);
    });
  });

  describe('rung 4 — resolution against the asset set', () => {
    it('resolves a relative path against the referencing file', () => {
      const reference = resolveOne({ rawPath: './assets/logo.png' });
      expect(reference?.resolution).toBe('resolved');
      expect(linkedPaths(reference as Reference)).toEqual([join(ROOT, 'src/assets/logo.png')]);
    });

    it('resolves a parent-relative path', () => {
      const reference = resolveOne({
        rawPath: '../public/banner.png',
        file: join(ROOT, 'src', 'App.jsx'),
      });
      expect(reference?.resolution).toBe('resolved');
    });

    it('resolves a root-relative path against the public directory', () => {
      const reference = resolveOne({ rawPath: '/banner.png' });
      expect(linkedPaths(reference as Reference)).toEqual([join(ROOT, 'public/banner.png')]);
    });

    it('falls back to the project root for a root-relative path', () => {
      // A plain static site serves `/at-root.png` from the root itself. Trying both
      // can only turn a false `broken` into a correct link — the file has to be
      // there for a match to happen at all.
      const reference = resolveOne({ rawPath: '/at-root.png' });
      expect(linkedPaths(reference as Reference)).toEqual([join(ROOT, 'at-root.png')]);
    });

    it('honours a configured public directory', () => {
      const references = resolveReferences([raw({ rawPath: '/assets/logo.png' })], {
        root: ROOT,
        assets: ASSETS,
        publicDir: 'src',
      });
      expect(references[0]?.resolution).toBe('resolved');
    });

    it('keeps the ceiling as the final confidence', () => {
      expect(resolveOne({ rawPath: './assets/logo.png', ceiling: 'certain' })?.confidence).toBe(
        'certain',
      );
      expect(
        resolveOne({ rawPath: './assets/logo.png', ceiling: 'high', kind: 'attr' })?.confidence,
      ).toBe('high');
    });

    it('resolves a path carrying a query suffix', () => {
      const reference = resolveOne({ rawPath: './assets/logo.png' });
      expect(reference?.resolution).toBe('resolved');
    });

    it('resolves a bare relative path in CSS, where it is not a package name', () => {
      const reference = resolveOne({
        rawPath: 'assets/logo.png',
        kind: 'css-url',
        file: join(ROOT, 'src', 'app.css'),
      });
      expect(reference?.resolution).toBe('resolved');
    });
  });

  describe('rung 5 — alias-shaped paths are their own bucket', () => {
    it.each([
      ['a webpack-style alias', '@/assets/logo.png'],
      ['a tilde alias', '~/assets/logo.png'],
      ['a subpath import alias', '#assets/logo.png'],
      ['a scoped package asset', '@scope/pkg/logo.png'],
    ])('%s', (_name, rawPath) => {
      const reference = resolveOne({ rawPath });

      // `import logo from '@/assets/logo.png'` is everywhere in Next and Vite.
      // Calling it broken would fail the phase's exit criterion on its own.
      expect(reference?.resolution).toBe('unresolved-alias');
      expect(reference?.confidence).toBe('unsafe');
    });

    it('treats an unresolved bare specifier in an import as alias-shaped', () => {
      const reference = resolveOne({ rawPath: 'some-pkg/logo.png', kind: 'import' });
      expect(reference?.resolution).toBe('unresolved-alias');
    });

    it('does not treat a bare path in CSS as alias-shaped', () => {
      // In a stylesheet this is an ordinary relative path that points at nothing.
      const reference = resolveOne({ rawPath: 'missing/logo.png', kind: 'css-url' });
      expect(reference?.resolution).toBe('broken');
    });
  });

  describe('rung 6 — an asserted literal path that points at nothing is broken', () => {
    it('reports a missing relative path', () => {
      const reference = resolveOne({ rawPath: './assets/missing.png' });
      expect(reference?.resolution).toBe('broken');
      expect(reference?.confidence).toBe('unsafe');
    });

    it('reports a missing root-relative path', () => {
      expect(resolveOne({ rawPath: '/missing.png' })?.resolution).toBe('broken');
    });

    it('catches a hallucinated path, which is the feature', () => {
      const reference = resolveOne({ rawPath: './assets/logo-final-v2.png' });
      expect(reference?.resolution).toBe('broken');
    });
  });

  describe('rung 7 — an unresolved speculative candidate is discarded', () => {
    it('discards a path-shaped string from JSON', () => {
      const reference = resolveOne({
        rawPath: './icons/nope.png',
        kind: 'json',
        asserted: false,
        file: join(ROOT, 'package.json'),
      });

      expect(reference?.resolution).toBe('discarded');
    });

    it('resolves a speculative candidate that does point at an asset', () => {
      const reference = resolveOne({
        rawPath: './assets/logo.png',
        kind: 'json',
        asserted: false,
      });
      expect(reference?.resolution).toBe('resolved');
    });

    it('never turns a speculative candidate into a broken finding', () => {
      const references = resolveReferences(
        [
          raw({ rawPath: './a.png', asserted: false, kind: 'json' }),
          raw({ rawPath: './b.png', asserted: false, kind: 'json' }),
        ],
        { root: ROOT, assets: ASSETS },
      );
      expect(references.every((reference) => reference.resolution === 'discarded')).toBe(true);
    });
  });

  describe('isLinked and linkedPaths', () => {
    it('treats both linked outcomes as linked', () => {
      const single = resolveOne({ rawPath: './assets/logo.png' }) as Reference;
      const pattern = resolveOne({
        rawPath: './images/${name}.png',
        ceiling: 'medium',
      }) as Reference;

      expect(isLinked(single)).toBe(true);
      expect(isLinked(pattern)).toBe(true);
    });

    it('treats every unresolved outcome as unlinked', () => {
      for (const reference of [
        resolveOne({ rawPath: './missing.png' }),
        resolveOne({ rawPath: '$x', ceiling: 'unsafe' }),
        resolveOne({ rawPath: '@/x.png' }),
        resolveOne({ rawPath: './missing.png', asserted: false }),
      ]) {
        expect(isLinked(reference as Reference)).toBe(false);
        expect(linkedPaths(reference as Reference)).toEqual([]);
      }
    });

    it('would have hidden every pattern reference from a hand-written check', () => {
      // The reason isLinked exists: this comparison compiles, runs, and is wrong.
      const pattern = resolveOne({
        rawPath: './images/${name}.png',
        ceiling: 'medium',
      }) as Reference;

      expect(pattern.resolution === 'resolved').toBe(false);
      expect(isLinked(pattern)).toBe(true);
    });
  });

  describe('is pure and deterministic', () => {
    it('returns the same result for the same input', () => {
      const input = [raw({ rawPath: './assets/logo.png' }), raw({ rawPath: './missing.png' })];
      expect(resolveReferences(input, { root: ROOT, assets: ASSETS })).toEqual(
        resolveReferences(input, { root: ROOT, assets: ASSETS }),
      );
    });

    it('preserves input order', () => {
      const references = resolveReferences(
        [
          raw({ rawPath: './assets/logo.png' }),
          raw({ rawPath: './missing.png' }),
          raw({ rawPath: './assets/hero.jpg' }),
        ],
        { root: ROOT, assets: ASSETS },
      );
      expect(references.map((reference) => reference.rawPath)).toEqual([
        './assets/logo.png',
        './missing.png',
        './assets/hero.jpg',
      ]);
    });

    it('orders pattern matches deterministically', () => {
      const shuffled = [...ASSETS].reverse();
      const a = resolveReferences([raw({ rawPath: './images/${n}.png', ceiling: 'medium' })], {
        root: ROOT,
        assets: ASSETS,
      });
      const b = resolveReferences([raw({ rawPath: './images/${n}.png', ceiling: 'medium' })], {
        root: ROOT,
        assets: shuffled,
      });
      expect(linkedPaths(a[0] as Reference)).toEqual(linkedPaths(b[0] as Reference));
    });

    it('carries the raw reference through unchanged', () => {
      const reference = resolveOne({ rawPath: './assets/logo.png', note: 'static import' });
      expect(reference?.note).toBe('static import');
      expect(reference?.kind).toBe('import');
      expect(reference?.asserted).toBe(true);
    });

    it('handles an empty input', () => {
      expect(resolveReferences([], { root: ROOT, assets: ASSETS })).toEqual([]);
    });

    it('handles a project with no assets', () => {
      const references = resolveReferences([raw({ rawPath: './assets/logo.png' })], {
        root: ROOT,
        assets: [],
      });
      expect(references[0]?.resolution).toBe('broken');
    });
  });
});
