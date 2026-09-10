import { describe, expect, it } from 'vitest';
import { type Hit, triage } from './triage.js';

/**
 * Every rule in `triage.ts` **removes an item from human review**, so the direction
 * that matters here is over-reach. A hit wrongly marked explained is a false negative
 * hidden inside the pass built to find false negatives, and nothing downstream looks
 * at it again.
 *
 * So the cases below are drawn from the three real repositories rather than invented,
 * and roughly half of them assert that a rule *declines* to fire.
 */

const CLAIMED = new Set(['.md', '.mdx', '.js', '.ts', '.tsx', '.json', '.html', '.css']);

function hit(file: string, text: string, asset: string, line = 1): Hit {
  return { asset, file, line, text };
}

function explanationFor(input: Hit): string | null {
  return triage(input, CLAIMED).explanation;
}

describe('§5.1(b) triage', () => {
  describe('rules that fire', () => {
    it('explains a file type no adapter reads', () => {
      expect(explanationFor(hit('config.yaml', 'image: hero.png', 'img/hero.png'))).toContain(
        'no adapter reads',
      );
    });

    it('explains a filename inside an absolute URL', () => {
      // astro-docs cites its own published assets this way, at volume.
      expect(
        explanationFor(
          hit(
            'doc.mdx',
            'See https://docs.astro.build/assets/arc.webp for more',
            'public/arc.webp',
          ),
        ),
      ).toContain('absolute URL');
    });

    it('explains a commented-out line', () => {
      // `eleventy.config.js:427` — a mapping someone disabled.
      expect(
        explanationFor(
          hit(
            'eleventy.config.js',
            '// [resolveModule("@11ty/logo/assets/open-graph.jpg")]: "img/open-graph.jpg",',
            'src/img/open-graph.jpg',
          ),
        ),
      ).toContain('commented out');
    });

    it('explains a line that names a different file with the same basename', () => {
      // `src/_data/mascots.js:11` writes `/img/mascots/possum.jpg`; the sweep matched
      // it to `src/img/possum.jpg`. Same basename, different file — renaming this
      // asset would not touch that line.
      expect(
        explanationFor(
          hit('src/_data/mascots.js', 'image: "/img/mascots/possum.jpg",', 'src/img/possum.jpg'),
        ),
      ).toContain('different file that shares a basename');
    });

    it('explains a filename in a sentence', () => {
      expect(
        explanationFor(
          hit(
            'guide.mdx',
            'In this example, a request for the file favicon.svg would be split into parameters',
            'public/favicon.svg',
          ),
        ),
      ).toContain('inside a sentence');
    });
  });

  describe('rules that must NOT fire — each of these is a real miss', () => {
    it('leaves a frontmatter path alone', () => {
      // `src/docs/languages/sass.md:9` — `logoImage: "/img/logos/sass.svg"` is a
      // genuine reference in YAML frontmatter that no adapter reads. Renaming the
      // asset breaks the site, so this must reach a person.
      expect(
        explanationFor(
          hit(
            'src/docs/languages/sass.md',
            'logoImage: "/img/logos/sass.svg"',
            'src/img/logos/sass.svg',
          ),
        ),
      ).toBeNull();
    });

    it('leaves a templated URL that resolves to this asset alone', () => {
      // `apps/v4/app/layout.tsx:44`. The prefix is assembled at runtime, so the
      // engine cannot link it — but a rename would break it.
      expect(
        explanationFor(
          hit(
            'apps/v4/app/layout.tsx',
            'url: `${siteConfig.url}/opengraph-image.png`,',
            'apps/v4/public/opengraph-image.png',
          ),
        ),
      ).toBeNull();
    });

    it('does not treat a URL elsewhere on the line as covering the token', () => {
      // The token has to be *inside* the URL. A line that links to a docs page and
      // separately references a local image is a live reference.
      expect(
        explanationFor(
          hit('doc.mdx', '[docs](https://example.com/guide) and <img src="hero.png">', 'hero.png'),
        ),
      ).toBeNull();
    });

    it('does not call an attribute prose, however long the line', () => {
      // The prose rule keys on the filename standing alone. Inside `src="…"` it does
      // not, and this line is long enough to trip a word count on its own.
      expect(
        explanationFor(
          hit(
            'page.mdx',
            'Here is a much longer line of documentation text with <img src="hero.png"> in it',
            'hero.png',
          ),
        ),
      ).toBeNull();
    });

    it('does not call a bare filename prose in a short data line', () => {
      // `src/data/logos.ts:56` — `{ file: 'gitbook.svg' }` is the R14 case and a
      // real reference. Too short to be a sentence, and not Markdown.
      expect(
        explanationFor(
          hit('src/data/logos.ts', "gitbook: { file: 'gitbook.svg' },", 'public/logos/gitbook.svg'),
        ),
      ).toBeNull();
    });

    it('does not treat a matching path as a collision', () => {
      // The path in the line and the asset are the same file, reached through a
      // serving root. The collision rule must not fire on that.
      expect(
        explanationFor(hit('page.html', '<img src="/img/hero.png">', 'src/img/hero.png')),
      ).toBeNull();
    });

    it('does not explain a bare filename in code just because a comment marker appears later', () => {
      expect(
        explanationFor(hit('app.ts', 'const src = "hero.png"; // the banner', 'hero.png')),
      ).toBeNull();
    });
  });

  describe('the residue is grouped by shape', () => {
    it('labels a key/value pair', () => {
      expect(
        triage(
          hit('sass.md', 'logoImage: "/img/logos/sass.svg"', 'src/img/logos/sass.svg'),
          CLAIMED,
        ).shape,
      ).toBe('a key/value pair in data or frontmatter');
    });

    it('labels an attribute', () => {
      expect(triage(hit('a.html', '<img src="hero.png">', 'hero.png'), CLAIMED).shape).toBe(
        'an attribute',
      );
    });

    it('carries no shape once explained, so the residue cannot include it', () => {
      expect(triage(hit('x.yaml', 'image: hero.png', 'hero.png'), CLAIMED).shape).toBeNull();
    });
  });
});
