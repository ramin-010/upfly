import { describe, expect, it } from 'vitest';
import { conventionLinkFor, detectConventionRoots } from './conventions.js';

/**
 * These pin what Next.js's convention is, where it applies and where it does not, rather
 * than that any particular asset came out alive: a test that blesses today's findings can
 * freeze a defect as intended behaviour.
 *
 * Over-reach is the dangerous direction. This mechanism suppresses `dead` findings, so
 * every false match silently removes a real finding from the report, which is why most of
 * what follows is about what it declines to claim.
 */
describe('framework conventions', () => {
  describe('detectConventionRoots', () => {
    it('finds an app root per config, not one per project', () => {
      // `shadcn-ui` holds seventeen `next.config.*` files and the one that matters
      // for `apps/v4/app/…` is `apps/v4/next.config.mjs`. A check at the project root
      // alone would find nothing there and leave the mechanism inert.
      const roots = detectConventionRoots([
        'next.config.js',
        'apps/v4/next.config.mjs',
        'templates/next-app/next.config.ts',
        'packages/core/src/index.ts',
      ]);

      expect(roots).toEqual([
        { framework: 'next', dir: '' },
        { framework: 'next', dir: 'apps/v4' },
        { framework: 'next', dir: 'templates/next-app' },
      ]);
    });

    it.each(['js', 'mjs', 'cjs', 'ts', 'mts', 'cts'])('accepts next.config.%s', (extension) => {
      expect(detectConventionRoots([`app/next.config.${extension}`])).toHaveLength(1);
    });

    it('is not fooled by a file that merely contains the name', () => {
      expect(
        detectConventionRoots([
          'docs/about-next.config.js',
          'next.config.js.md',
          'next.config.json',
          'src/next.config.test.ts',
        ]),
      ).toEqual([]);
    });
  });

  describe('conventionLinkFor', () => {
    const roots = [{ framework: 'next', dir: 'apps/v4' }] as const;

    it.each([
      'apps/v4/app/opengraph-image.jpg',
      'apps/v4/app/(app)/(styles)/sera/opengraph-image.jpg',
      'apps/v4/app/(app)/(styles)/sera/twitter-image.jpg',
      'apps/v4/app/blog/icon.png',
      'apps/v4/app/blog/apple-icon.png',
    ])('claims %s', (asset) => {
      expect(conventionLinkFor(asset, roots)?.reason).toContain('Next.js reads this');
    });

    it('claims the numbered variants, because the framework allows them', () => {
      // Next supports `icon1.png`, `icon2.png` when a route needs several. Matching
      // only the bare name would leave exactly the repositories that use the
      // feature most with false `dead` findings.
      expect(conventionLinkFor('apps/v4/app/icon2.png', roots)).not.toBeNull();
      expect(conventionLinkFor('apps/v4/app/opengraph-image3.jpg', roots)).not.toBeNull();
    });

    // --- where it must not reach ------------------------------------------------
    // Each of these is a real `dead` finding this mechanism would suppress if it
    // were one character looser.

    it('does not claim a public-directory asset of the same name', () => {
      // Next applies these conventions only inside `app/`. `shadcn-ui` has both:
      // `apps/v4/app/…/twitter-image.jpg` is convention, and
      // `apps/v4/public/twitter-image.png` is an ordinary public asset that the
      // public-dir caveat already covers. Treating the second as alive would
      // suppress a genuine finding on the strength of a filename.
      expect(conventionLinkFor('apps/v4/public/twitter-image.png', roots)).toBeNull();
      expect(conventionLinkFor('apps/v4/public/favicon-32x32.png', roots)).toBeNull();
    });

    it('does not claim an ordinary asset that happens to live under app/', () => {
      expect(conventionLinkFor('apps/v4/app/blog/hero.png', roots)).toBeNull();
      expect(conventionLinkFor('apps/v4/app/blog/icon-large.png', roots)).toBeNull();
    });

    it('does not claim a reserved name outside any app root', () => {
      expect(conventionLinkFor('docs/app/opengraph-image.jpg', roots)).toBeNull();
      expect(conventionLinkFor('apps/v4/opengraph-image.jpg', roots)).toBeNull();
    });

    it('claims nothing at all when no framework was detected', () => {
      // astro-docs and eleventy-docs, two of the validation repositories, have no
      // `next.config.*` anywhere, so the mechanism must be inert there rather than
      // matching on the name alone.
      expect(conventionLinkFor('app/opengraph-image.jpg', [])).toBeNull();
    });

    it('accepts the src/app layout, which Next supports and shadcn-ui uses', () => {
      // Next supports `src/app`, and `shadcn-ui` holds six `src/app` directories.
      expect(conventionLinkFor('apps/v4/src/app/icon.png', roots)).not.toBeNull();
    });

    it('still requires app to be the router directory, not any folder named app', () => {
      expect(conventionLinkFor('apps/v4/vendor/app/icon.png', roots)).toBeNull();
      expect(conventionLinkFor('apps/v4/src/lib/app/icon.png', roots)).toBeNull();
    });
  });
});
