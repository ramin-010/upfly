import { describe, expect, it } from 'vitest';
import { type Hit, fencedLines, hitsIn, triage } from './triage.js';

/**
 * Every rule in `triage.ts` removes an item from human review, so the direction that
 * matters here is over-reach. A hit wrongly marked explained is a missed reference hidden
 * inside the pass built to find missed references, and nothing downstream looks at it
 * again.
 *
 * So the cases come from the validation repositories in `repos.ts` wherever one shows the
 * shape, and about half of them assert that a rule declines to fire.
 */

const CLAIMED = new Set(['.md', '.mdx', '.js', '.ts', '.tsx', '.json', '.html', '.css']);

function hit(file: string, text: string, asset: string, line = 1): Hit {
  return { asset, file, line, text, fenced: false };
}

function fencedHit(file: string, text: string, asset: string): Hit {
  return { ...hit(file, text, asset), fenced: true };
}

function explanationFor(input: Hit): string | null {
  return triage(input, CLAIMED).explanation;
}

describe('triage of the hits the graph did not link', () => {
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
      // `eleventy.config.js:427`: a mapping someone disabled.
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

    it.each([
      ['app.js', "// import hero from './hero.png'"],
      ['Hero.ts', ' * @see hero.png'],
      ['guide.md', '<!-- ![old](hero.png) -->'],
      ['site.css', '/* url(hero.png) */'],
    ])('explains a comment in %s, written as that type of file writes one', (file, text) => {
      expect(explanationFor(hit(file, text, 'hero.png'))).toContain('commented out');
    });

    it('explains a line that names a different file with the same basename', () => {
      // `src/_data/mascots.js:11` writes `/img/mascots/possum.jpg`; the sweep matched
      // it to `src/img/possum.jpg`. Same basename, different file: renaming this
      // asset would not touch that line.
      expect(
        explanationFor(
          hit('src/_data/mascots.js', 'image: "/img/mascots/possum.jpg",', 'src/img/possum.jpg'),
        ),
      ).toContain('different file that shares a basename');
    });

    it('explains a relative path that lands on a different file with the same basename', () => {
      // From `docs/pages`, `../img/possum.jpg` is `docs/img/possum.jpg`.
      expect(
        explanationFor(
          hit('docs/pages/index.html', '<img src="../img/possum.jpg">', 'src/img/possum.jpg'),
        ),
      ).toContain('different file that shares a basename');
    });

    it('explains raw HTML inside a fenced code block as a documentation example', () => {
      // `src/docs/plugins/image-webc.md:67`, inside an html fence.
      expect(
        explanationFor(
          fencedHit(
            'src/docs/plugins/image-webc.md',
            '<img webc:is="eleventy-image" src="cat.jpg" alt="photo of my tabby cat">',
            'src/img/mascots/cat.jpg',
          ),
        ),
      ).toContain('documentation example');
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

  describe('rules that must not fire: each of these is a real miss', () => {
    it('leaves a frontmatter path alone', () => {
      // `src/docs/languages/sass.md:9`: `logoImage: "/img/logos/sass.svg"` is a
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
      // engine cannot link it, but a rename would break it.
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
      // The token has to be inside the URL. A line that links to a docs page and
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
      // `src/data/logos.ts:56`: `{ file: 'gitbook.svg' }` is a real reference, a filename
      // in a data object that code turns into a path. Too short to be a sentence, and not
      // Markdown.
      expect(
        explanationFor(
          hit('src/data/logos.ts', "gitbook: { file: 'gitbook.svg' },", 'public/logos/gitbook.svg'),
        ),
      ).toBeNull();
    });

    it.each([
      ['guide.md', '* ![hero](hero.png)', 'hero.png'],
      ['notes.md', '// ![hero](hero.png)', 'hero.png'],
      ['README.md', '# <img src="logo.png" width="32"> Upfly', 'logo.png'],
      ['site.css', '#banner { background: url(banner.png); }', 'banner.png'],
      ['Hero.ts', "  #icon = '/img/icon.png';", 'img/icon.png'],
    ])('does not take a line of %s for a comment in another language', (file, text, asset) => {
      expect(explanationFor(hit(file, text, asset))).toBeNull();
    });

    it.each([
      ['src/pages/index.html', '<img src="../img/possum.jpg">'],
      ['src/pages/blog/post.html', '<img src="../../img/possum.jpg">'],
    ])(
      'does not call a relative path in %s a different file when it lands on the asset',
      (file, text) => {
        expect(explanationFor(hit(file, text, 'src/img/possum.jpg'))).toBeNull();
      },
    );

    it('leaves raw HTML outside a fence alone, since the page renders it', () => {
      // `src/docs/community.md:45`: the include writes the SVG into the page, so renaming
      // the asset breaks the build.
      expect(
        explanationFor(
          hit(
            'src/docs/community.md',
            '<a href="{{ config.kickstarterUrl }}" class="announcement-btn">{% include "components/ba-balloon.svg" %}Subscribe to the Build Awesome Kickstarter</a>',
            'src/_includes/components/ba-balloon.svg',
          ),
        ),
      ).toBeNull();
    });

    it.each([
      ['a table row', 'guide.md', '| ![The hero](hero.png) | The page banner |'],
      ['an MDX import', 'page.mdx', "import hero from './hero.png';"],
    ])('leaves %s outside a fence alone', (_name, file, text) => {
      expect(explanationFor(hit(file, text, 'hero.png'))).toBeNull();
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

  describe('the hits the sweep finds in a file', () => {
    /** A lookup that knows only these assets, as the sweep's does, by lowercased basename. */
    function named(...assets: string[]): (name: string) => readonly string[] {
      return (name) =>
        assets.filter((asset) => asset.slice(asset.lastIndexOf('/') + 1).toLowerCase() === name);
    }

    function found(text: string, ...assets: string[]): string[] {
      return hitsIn('page.html', text, named(...assets)).map((hit) => hit.asset);
    }

    it('finds a name holding a space, as the engine spells names', () => {
      expect(found('<img src="/img/team photo.png">', 'img/team photo.png')).toEqual([
        'img/team photo.png',
      ]);
    });

    it('finds a name holding parentheses, as a browser names a second download', () => {
      expect(found('<img src="/img/photo(1).png">', 'img/photo(1).png')).toEqual([
        'img/photo(1).png',
      ]);
      expect(found('<img src="/img/hero (1).png">', 'img/hero (1).png')).toEqual([
        'img/hero (1).png',
      ]);
    });

    it('finds a plain name once for each asset that shares it, ignoring case', () => {
      expect(found('<img src="/img/HERO.png">', 'a/hero.png', 'b/hero.png')).toEqual([
        'a/hero.png',
        'b/hero.png',
      ]);
    });

    it('gives each hit its line, the text of the line and whether a fence holds it', () => {
      const text = ['Intro', '```html', '<img src="hero.png">', '```', '<img src="hero.png">'];
      const hits = hitsIn('guide.md', text.join('\n'), named('hero.png'));

      expect(hits.map((hit) => [hit.line, hit.text, hit.fenced])).toEqual([
        [3, '<img src="hero.png">', true],
        [5, '<img src="hero.png">', false],
      ]);
    });
  });

  describe('the lines a fenced code block holds', () => {
    it('counts a backtick fence and a tilde fence, their fence lines included', () => {
      const text = ['intro', '```html', '<img src="a.png">', '```', 'prose', '~~~', 'b.png', '~~~'];

      expect([...fencedLines([...text, 'after'].join('\n'))]).toEqual([2, 3, 4, 6, 7, 8]);
    });

    it.each([
      ['a run of the other character', ['````', '~~~~', 'a.png', '````']],
      ['a shorter run', ['````', '```', 'a.png', '````']],
      ['a run with text after it', ['```', '``` more', 'a.png', '```']],
      ['a run indented four spaces', ['```', '    ```', 'a.png', '```']],
    ])('does not close a fence with %s', (_name, lines) => {
      expect([...fencedLines([...lines, 'after'].join('\n'))]).toEqual([1, 2, 3, 4]);
    });

    it('opens no backtick fence whose info string holds a backtick', () => {
      // The last fence line opens a block that never closes, so nothing is held.
      const text = ['``` a`b', 'a.png', '```', 'prose'].join('\n');

      expect([...fencedLines(text)]).toEqual([]);
    });

    it('counts a fence indented under a list item when its lines keep the indent', () => {
      // `src/content/docs/en/tutorial/1-setup/3.mdx:34` in astro-docs, a step's example.
      const text = [
        '1. Open the page:',
        '',
        '    ```astro',
        '    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />',
        '',
        '    ```',
        'after',
      ];

      expect([...fencedLines(text.join('\n'))]).toEqual([3, 4, 5, 6]);
    });

    it('holds nothing for a fence that never closes, or an indented one a line steps out of', () => {
      // Neither is certain to be code: a stray fence line is often a typo, and a line that
      // leaves the indent is a paragraph if the fence lines are indented code.
      expect([...fencedLines(['```', 'a.png'].join('\n'))]).toEqual([]);
      expect([...fencedLines(['    ```', 'a.png', '    ```'].join('\n'))]).toEqual([]);
    });

    it('reads a file with CR LF line endings', () => {
      expect([...fencedLines('```\r\na.png\r\n```\r\n')]).toEqual([1, 2, 3]);
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
