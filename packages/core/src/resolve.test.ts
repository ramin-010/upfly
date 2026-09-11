import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toPosix } from './paths.js';
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

/**
 * The default `exists` port: nothing exists beyond the asset set.
 *
 * Injected rather than imported so the resolver stays pure — the same shape as the
 * `ImageProbe` port — and so a test can decide exactly what is on the disk.
 */
const NOTHING_EXISTS = (): boolean => false;

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

/**
 * Assert the outcome and narrow to it in one step.
 *
 * `Reference` is a union, so `reference?.exclusionReason` does not typecheck — and
 * that error was invisible for as long as test files went unchecked (rule 17). The
 * runtime hazard is the quieter one: an optional chain into the wrong branch yields
 * `undefined`, and `undefined` compares equal to nothing at all, so an assertion can
 * pass by luck rather than by the resolver being right.
 *
 * Throwing here names the resolution we actually got, which is the thing worth
 * knowing when this fails.
 */
function expectResolution<K extends Reference['resolution']>(
  reference: Reference | undefined,
  resolution: K,
): Extract<Reference, { resolution: K }> {
  if (reference?.resolution !== resolution) {
    throw new Error(
      `expected resolution '${resolution}', got '${reference?.resolution ?? 'none'}'`,
    );
  }
  return reference as Extract<Reference, { resolution: K }>;
}

function resolveOne(overrides: Partial<RawReference> & { rawPath: string }): Reference | undefined {
  return resolveReferences([raw(overrides)], {
    root: ROOT,
    assets: ASSETS,
    exists: NOTHING_EXISTS,
  })[0];
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
      expect(
        resolveReferences([raw({ rawPath })], {
          root: ROOT,
          assets: ASSETS,
          exists: NOTHING_EXISTS,
        }),
      ).toEqual([]);
    });

    it('drops them before the broken test, which is the point', () => {
      // Behind the resolution test, every `url(inter.woff2)` becomes a finding.
      const references = resolveReferences(
        [raw({ rawPath: './inter.woff2', kind: 'css-url' }), raw({ rawPath: './assets/logo.png' })],
        { root: ROOT, assets: ASSETS, exists: NOTHING_EXISTS },
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

    it('tries every serving root a monorepo has', () => {
      // R13. shadcn-ui has six `public/` directories, and resolving a file under
      // `apps/v4/` against a single one produced 93 false `broken` findings.
      const monorepo = [asset('apps/v4/public/images/hero.png')];

      const [resolved] = resolveReferences(
        [raw({ rawPath: '/images/hero.png', file: join(ROOT, 'apps/v4/app/page.tsx') })],
        {
          root: ROOT,
          assets: monorepo,
          publicDirs: ['apps/www/public', 'apps/v4/public'],
          exists: NOTHING_EXISTS,
        },
      );

      expect(resolved?.resolution).toBe('resolved');
    });

    it('prefers the serving root nearest the referencing file', () => {
      // Both exist and both match by name. A bundler serves the app the file
      // belongs to; picking the other silently rewrites the wrong asset in Phase 2,
      // which nothing downstream of here could catch.
      const monorepo = [asset('apps/v4/public/logo.png'), asset('apps/www/public/logo.png')];

      const [resolved] = resolveReferences(
        [raw({ rawPath: '/logo.png', file: join(ROOT, 'apps/v4/app/page.tsx') })],
        {
          root: ROOT,
          assets: monorepo,
          // Deliberately listed with the wrong one first: order in the list must not
          // decide precedence, proximity must.
          publicDirs: ['apps/www/public', 'apps/v4/public'],
          exists: NOTHING_EXISTS,
        },
      );

      expect(resolved?.resolution === 'resolved' && toPosix(resolved.resolvedPath)).toBe(
        toPosix(join(ROOT, 'apps/v4/public/logo.png')),
      );
    });

    it('never links to a serving root that is not an ancestor', () => {
      // The correction to R13's first version, and it was found by measuring rather
      // than reasoning. "Trying more roots can only turn a false `broken` into a
      // correct link" holds when every root serves the same URL space; a monorepo's
      // do not. Trying them all linked 23 shadcn-ui references to *another app's*
      // asset — a fixture app's `/next.svg` to `apps/v4/public/next.svg` — and
      // Phase 2 would rewrite that to a file the fixture app does not serve.
      const monorepo = [asset('apps/v4/public/next.svg')];

      const [resolved] = resolveReferences(
        [raw({ rawPath: '/next.svg', file: join(ROOT, 'packages/fixtures/next-app/page.tsx') })],
        {
          root: ROOT,
          assets: monorepo,
          publicDirs: ['apps/v4/public'],
          exists: NOTHING_EXISTS,
        },
      );

      // Broken is the honest answer: that app does not serve this URL. A false
      // `broken` costs a user five minutes; a false link costs them a broken build.
      expect(resolved?.resolution).toBe('broken');
    });

    it('honours a configured public directory', () => {
      const references = resolveReferences([raw({ rawPath: '/assets/logo.png' })], {
        root: ROOT,
        assets: ASSETS,
        publicDirs: ['src'],
        exists: NOTHING_EXISTS,
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

  describe('R15 — a `./` path meant relative to the project root', () => {
    it('lets a speculative dot-path fall back to the project root', () => {
      // astro-docs: `path: './src/pages/.../docs-logo.png'` in an object, handed to
      // a filesystem read where the cwd is the project root. Resolved against the
      // file it lands on `src/pages/open-graph/src/pages/...`, which is nowhere.
      const [resolved] = resolveReferences(
        [
          raw({
            rawPath: './src/assets/logo.png',
            file: join(ROOT, 'src/pages/deep/handler.ts'),
            asserted: false,
            ceiling: 'high',
          }),
        ],
        { root: ROOT, assets: ASSETS, exists: NOTHING_EXISTS },
      );

      expect(resolved?.resolution).toBe('resolved');
      // Recorded, not re-derived: Phase 2 must know this link is evidence the asset
      // is alive and NOT licence to rewrite the string, because the code may join
      // it to a different base entirely.
      //
      // R36 split this from the root-relative fallback. This is the weak one -- a
      // guess at the base of a string that was already a guess -- and it is the case
      // R15 was written about. Measured at 10 occurrences across five repositories,
      // none of them asserted.
      expect(resolved?.resolution === 'resolved' && resolved.resolvedVia).toBe('speculative-root');
    });

    it('refuses the same fallback for an asserted import', () => {
      // `./` in a module system unambiguously means file-relative. Falling back
      // here would link a genuinely broken import to an unrelated file — a false
      // link, and a false link costs a broken build where a false broken costs
      // five minutes.
      const [resolved] = resolveReferences(
        [
          raw({
            rawPath: './src/assets/logo.png',
            file: join(ROOT, 'src/pages/deep/handler.ts'),
          }),
        ],
        { root: ROOT, assets: ASSETS, exists: NOTHING_EXISTS },
      );

      expect(resolved?.resolution).toBe('broken');
    });

    it('records how an ordinary relative reference resolved', () => {
      const reference = resolveOne({ rawPath: './assets/logo.png' });

      expect(reference?.resolution === 'resolved' && reference.resolvedVia).toBe('file');
    });

    it('records a serving-root resolution as one', () => {
      const [resolved] = resolveReferences([raw({ rawPath: '/banner.png' })], {
        root: ROOT,
        assets: ASSETS,
        publicDirs: ['public'],
        exists: NOTHING_EXISTS,
      });

      expect(resolved?.resolution === 'resolved' && resolved.resolvedVia).toBe('serving-root');
    });

    it('records the project-root fallback for a root-relative path as one', () => {
      // `at-root.png` is not under `public/`, so no configured serving root has it
      // and the engine is guessing at the base.
      const [resolved] = resolveReferences([raw({ rawPath: '/at-root.png' })], {
        root: ROOT,
        assets: ASSETS,
        publicDirs: ['public'],
        exists: NOTHING_EXISTS,
      });

      expect(resolved?.resolution === 'resolved' && resolved.resolvedVia).toBe('project-root');
    });

    it('tells the two root fallbacks apart (R36)', () => {
      // These were ONE value, and merging them was not free. Measured across the five
      // validation repositories: the root-relative fallback fires 1,325 times with
      // 1,267 of them asserted -- `<img src="/favicon.png">` in hand-written HTML,
      // resolving to a file the site really serves from the project root -- while the
      // speculative retry fires 10 times, never asserted. Treating a static site's
      // ordinary reference as the same evidence as a guess-on-a-guess would forgo
      // rewrites we can safely make, on exactly the repositories in the target market.
      const [rootRelative] = resolveReferences([raw({ rawPath: '/at-root.png' })], {
        root: ROOT,
        assets: ASSETS,
        publicDirs: ['public'],
        exists: NOTHING_EXISTS,
      });
      const [speculative] = resolveReferences(
        [raw({ rawPath: './at-root.png', asserted: false, ceiling: 'high' })],
        { root: ROOT, assets: ASSETS, publicDirs: ['public'], exists: NOTHING_EXISTS },
      );

      const viaOf = (reference: Reference | undefined): string | null =>
        reference?.resolution === 'resolved' ? reference.resolvedVia : null;

      expect(viaOf(rootRelative)).toBe('project-root');
      expect(viaOf(speculative)).toBe('speculative-root');
      // The assertion that matters is that they DIFFER; pinning each value
      // separately would still pass if both collapsed back to one name.
      expect(viaOf(rootRelative)).not.toBe(viaOf(speculative));
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

  describe('rung 5 — a path into an excluded directory is out-of-scope, not broken', () => {
    const EXCLUDED = [
      {
        path: join(ROOT, 'legacy'),
        relative: 'legacy',
        reason: "the ignore rule 'legacy/'",
      },
    ];

    function resolveWithExclusions(
      rawPath: string,
      exists: (path: string) => boolean = () => false,
    ) {
      return resolveReferences([raw({ rawPath, kind: 'css-url' })], {
        root: ROOT,
        assets: ASSETS,
        excludedRoots: EXCLUDED,
        exists,
      })[0];
    }

    it('names the rule that excluded the target', () => {
      // The user ignored `legacy/` and is still referencing it. A broken finding
      // here would be a false positive, and the exit criterion allows none.
      const reference = resolveWithExclusions('../legacy/old.png');

      expect(expectResolution(reference, 'out-of-scope').exclusionReason).toBe(
        "the ignore rule 'legacy/'",
      );
    });

    it('knows exactly where it points', () => {
      const reference = resolveWithExclusions('../legacy/old.png');
      expect(expectResolution(reference, 'out-of-scope').resolvedPath).toBe(
        toPosix(join(ROOT, 'legacy/old.png')),
      );
    });

    it('is never linked, so it cannot be rewritten and cannot be a dead asset', () => {
      const reference = resolveWithExclusions('../legacy/old.png') as Reference;
      expect(isLinked(reference)).toBe(false);
      expect(linkedPaths(reference)).toEqual([]);
      expect(reference.confidence).toBe('unsafe');
    });

    it('falls back to the filesystem for a file-level ignore rule', () => {
      // `*.png` in .upflyignore excludes a file without pruning any directory, so
      // there is no excluded root to match. The file is still sitting right there.
      const target = toPosix(join(ROOT, 'src/hidden.png'));
      const reference = resolveWithExclusions('./hidden.png', (path) => path === target);

      expect(expectResolution(reference, 'out-of-scope').exclusionReason).toBe(
        'resolved outside the indexed asset set',
      );
    });

    it('is still broken when the file genuinely is not there', () => {
      expect(resolveWithExclusions('./nowhere.png')?.resolution).toBe('broken');
    });

    it('consults the filesystem only for a reference about to be called broken', () => {
      // One stat per would-be-broken reference, never per reference.
      const asked: string[] = [];
      resolveReferences(
        [
          raw({ rawPath: './assets/logo.png' }),
          raw({ rawPath: './assets/hero.jpg' }),
          raw({ rawPath: './missing.png' }),
        ],
        {
          root: ROOT,
          assets: ASSETS,
          exists: (path) => {
            asked.push(path);
            return false;
          },
        },
      );

      expect(asked).toEqual([toPosix(join(ROOT, 'src/missing.png'))]);
    });

    it('takes precedence over the alias bucket', () => {
      const reference = resolveReferences([raw({ rawPath: '@/legacy/old.png' })], {
        root: ROOT,
        assets: ASSETS,
        excludedRoots: EXCLUDED,
        exists: (path) => path === toPosix(join(ROOT, 'src/@/legacy/old.png')),
      })[0];

      expect(reference?.resolution).toBe('out-of-scope');
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
        { root: ROOT, assets: ASSETS, exists: NOTHING_EXISTS },
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
      expect(
        resolveReferences(input, { root: ROOT, assets: ASSETS, exists: NOTHING_EXISTS }),
      ).toEqual(resolveReferences(input, { root: ROOT, assets: ASSETS, exists: NOTHING_EXISTS }));
    });

    it('preserves input order', () => {
      const references = resolveReferences(
        [
          raw({ rawPath: './assets/logo.png' }),
          raw({ rawPath: './missing.png' }),
          raw({ rawPath: './assets/hero.jpg' }),
        ],
        { root: ROOT, assets: ASSETS, exists: NOTHING_EXISTS },
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
        exists: NOTHING_EXISTS,
      });
      const b = resolveReferences([raw({ rawPath: './images/${n}.png', ceiling: 'medium' })], {
        root: ROOT,
        assets: shuffled,
        exists: NOTHING_EXISTS,
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
      expect(resolveReferences([], { root: ROOT, assets: ASSETS, exists: NOTHING_EXISTS })).toEqual(
        [],
      );
    });

    it('handles a project with no assets', () => {
      const references = resolveReferences([raw({ rawPath: './assets/logo.png' })], {
        root: ROOT,
        assets: [],
        exists: NOTHING_EXISTS,
      });
      expect(references[0]?.resolution).toBe('broken');
    });
  });

  describe('a dynamic path whose static suffix rules out an image (R21)', () => {
    /**
     * `34 references could not be resolved safely` listed 106 entries with no image
     * among them — and that bucket is what §1.1 shows a user as "references I
     * couldn't safely rewrite". On `shadcn-ui`, 127 of 187 carried a statically
     * visible non-image extension.
     *
     * The suffix is right there, so no resolution is needed to rule these out. They
     * are dropped exactly as rung 3 drops `url(inter.woff2)`: never a candidate
     * asset, so declining one is not a skip under rule 9.
     */

    it.each([
      'components/ui/${name}.tsx',
      'registry/${style}/${name}.json',
      '${siteConfig.url}/rss.xml',
      'src/${dir}/notes.md',
      'backup/${name}.bak',
    ])('drops %s', (rawPath) => {
      expect(resolveOne({ rawPath, ceiling: 'medium' })).toBeUndefined();
    });

    it.each(['images/${name}.png', '{{ site.url }}/img/hero.jpg', './assets/${slug}.svg'])(
      'keeps %s, which could still be an asset',
      (rawPath) => {
        // Not asserted as `dynamic` specifically: one of these glob-matches a real
        // fixture asset and comes back `resolved-pattern`, which is a better outcome
        // than the one being tested for. What matters is that it survives.
        expect(resolveOne({ rawPath, ceiling: 'medium' })).toBeDefined();
      },
    );

    it('keeps a path with no static extension at all — unknown is not ruled out', () => {
      // `/view/${style}/${name}` shows nothing, so nothing can be concluded. It is
      // counted rather than listed by the report, but it must survive resolution.
      expect(resolveOne({ rawPath: '/view/${style}/${name}', ceiling: 'medium' })?.resolution).toBe(
        'dynamic',
      );
    });

    it('keeps a hole that IS the extension', () => {
      // `hero.${ext}` could be `hero.png`. Ruling it out on the strength of `.*`
      // would be the over-fix, and it is the one this rule is closest to.
      expect(resolveOne({ rawPath: 'hero.${ext}', ceiling: 'medium' })?.resolution).toBe('dynamic');
    });

    it('does not swallow url($hero), which is what pins rung 3 in place', () => {
      // ⚠️ The reason this is a separate mechanism rather than moving the extension
      // filter up the ladder. `$hero` has no static extension, so it is unknown
      // rather than ruled out, and it must still be reported as dynamic.
      expect(resolveOne({ rawPath: '$hero', ceiling: 'unsafe' })?.resolution).toBe('dynamic');
    });
  });
});
