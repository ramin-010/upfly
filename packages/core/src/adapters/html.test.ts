import { describe, expect, it } from 'vitest';
import type { RawReference } from '../types.js';
import { NO_REFERENCE_TO_FIND, htmlAdapter } from './html.js';
import { decodeCharacterReferencesWithMap } from './reference-path.js';

/**
 * Table-driven, per the adapter contract. As with CSS, every case slices the path
 * back out of the source using the reference's own range: an off-by-one here is a
 * rewrite that lands in the wrong place and corrupts a document.
 */

function find(text: string, file = '/project/index.html'): RawReference[] {
  return htmlAdapter.findReferences({ file, text });
}

function paths(text: string): string[] {
  return find(text).map((reference) => reference.rawPath);
}

function slices(text: string): string[] {
  return find(text).map((reference) => text.slice(reference.start, reference.end));
}

describe('htmlAdapter', () => {
  it('claims the html extensions', () => {
    expect(htmlAdapter.id).toBe('html');
    expect(htmlAdapter.extensions).toEqual(['.html', '.htm']);
  });

  describe('single-URL attributes', () => {
    const cases: ReadonlyArray<[name: string, source: string, expected: readonly string[]]> = [
      ['img src', '<img src="hero.png">', ['hero.png']],
      ['img src, single quoted', "<img src='hero.png'>", ['hero.png']],
      ['img src, unquoted', '<img src=hero.png>', ['hero.png']],
      ['video poster', '<video poster="p.png"></video>', ['p.png']],
      ['video src', '<video src="v.webm"></video>', ['v.webm']],
      ['audio src', '<audio src="a.mp3"></audio>', ['a.mp3']],
      ['source src', '<audio><source src="a.ogg"></audio>', ['a.ogg']],
      ['embed src', '<embed src="e.svg">', ['e.svg']],
      ['input src', '<input type="image" src="go.png">', ['go.png']],
      ['object data', '<object data="o.svg"></object>', ['o.svg']],
      ['track src', '<video><track src="c.vtt"></video>', ['c.vtt']],
      ['relative path', '<img src="../img/hero.png">', ['../img/hero.png']],
      ['root-relative path', '<img src="/img/hero.png">', ['/img/hero.png']],
      ['two images', '<img src="a.png"><img src="b.png">', ['a.png', 'b.png']],
    ];

    it.each(cases)('%s', (_name, source, expected) => {
      expect(paths(source)).toEqual([...expected]);
      expect(slices(source)).toEqual([...expected]);
    });

    it('ignores attributes that are not references', () => {
      expect(paths('<img alt="a picture of hero.png" title="hero.png" src="real.png">')).toEqual([
        'real.png',
      ]);
    });

    it('ignores href on an ordinary link', () => {
      expect(paths('<a href="page.html">go</a>')).toEqual([]);
    });

    it('ignores framework binding attributes, which hold expressions not paths', () => {
      // `:src` (Vue) and `[src]` (Angular) contain code; the plain `src` does not.
      expect(paths('<img :src="hero" [src]="hero" src="real.png">')).toEqual(['real.png']);
    });
  });

  describe('srcset', () => {
    const cases: ReadonlyArray<[name: string, source: string, expected: readonly string[]]> = [
      ['density descriptors', '<img srcset="a.png 1x, b.png 2x">', ['a.png', 'b.png']],
      ['width descriptors', '<img srcset="a.png 480w, b.png 800w">', ['a.png', 'b.png']],
      ['no descriptor', '<img srcset="a.png">', ['a.png']],
      // Per the HTML spec's srcset algorithm the URL is "a sequence of code points
      // that are not ASCII whitespace", so with no space this is one malformed URL,
      // not two. Reporting it as written is right: the browser sees one URL too, and
      // a broken finding here tells the author their srcset is wrong.
      ['comma with no whitespace is one URL', '<img srcset="a.png,b.png">', ['a.png,b.png']],
      ['trailing comma ends the candidate', '<img srcset="a.png,  b.png 2x">', ['a.png', 'b.png']],
      ['extra whitespace', '<img srcset="  a.png 1x ,   b.png 2x  ">', ['a.png', 'b.png']],
      ['newlines between candidates', '<img srcset="a.png 1x,\n  b.png 2x">', ['a.png', 'b.png']],
      ['on a source element', '<picture><source srcset="s.avif"></picture>', ['s.avif']],
      [
        'src and srcset together',
        '<img src="fallback.png" srcset="a.png 1x, b.png 2x">',
        ['fallback.png', 'a.png', 'b.png'],
      ],
    ];

    it.each(cases)('%s', (_name, source, expected) => {
      expect(paths(source)).toEqual([...expected]);
      expect(slices(source)).toEqual([...expected]);
    });

    it('rewrites one candidate without disturbing the others', () => {
      const source = '<img srcset="a.png 1x, b.png 2x">';
      const references = find(source);
      const second = references[1];
      const rewritten = htmlAdapter.rewrite({
        text: source,
        edits: [{ start: second?.start ?? 0, end: second?.end ?? 0, replacement: 'b.webp' }],
      });
      expect(rewritten).toBe('<img srcset="a.png 1x, b.webp 2x">');
    });
  });

  describe('link elements', () => {
    const iconCases: ReadonlyArray<[name: string, source: string]> = [
      ['icon', '<link rel="icon" href="fav.png">'],
      ['shortcut icon', '<link rel="shortcut icon" href="fav.png">'],
      ['apple-touch-icon', '<link rel="apple-touch-icon" href="fav.png">'],
      ['mask-icon', '<link rel="mask-icon" href="fav.png">'],
      ['uppercase rel', '<link rel="ICON" href="fav.png">'],
      ['preloaded image', '<link rel="preload" as="image" href="fav.png">'],
    ];

    it.each(iconCases)('finds %s', (_name, source) => {
      expect(paths(source)).toEqual(['fav.png']);
      expect(slices(source)).toEqual(['fav.png']);
    });

    it('ignores a stylesheet link', () => {
      expect(paths('<link rel="stylesheet" href="site.css">')).toEqual([]);
    });

    it('ignores a preload that is not an image', () => {
      expect(paths('<link rel="preload" as="font" href="inter.woff2">')).toEqual([]);
    });

    it('ignores a link with no rel at all', () => {
      expect(paths('<link href="mystery.png">')).toEqual([]);
    });
  });

  describe('link previews and links to images', () => {
    const found: ReadonlyArray<[name: string, source: string, shape: string]> = [
      [
        'an Open Graph image',
        '<meta property="og:image" content="/img/banner.png">',
        'html.meta.content.image',
      ],
      [
        'a Twitter image',
        '<meta name="twitter:image" content="/img/hero.jpg">',
        'html.meta.content.image',
      ],
      [
        'a Windows tile image',
        '<meta name="msapplication-TileImage" content="/icons/icon-192.png">',
        'html.meta.content.image',
      ],
      ['a download link', '<a href="/img/team.jpg" download>x</a>', 'html.a.href.image'],
      ['an uppercase extension', '<a href="/gallery/Banner.PNG">x</a>', 'html.a.href.image'],
      ['a link to a vector', '<a href="/icons/mask.svg">x</a>', 'html.a.href.image'],
    ];

    it.each(found)('reads %s under its own shape', (_name, source, shape) => {
      const references = find(source);
      expect(references.map((reference) => reference.shape)).toEqual([shape]);
      expect(slices(source)).toEqual(paths(source));
    });

    it('reads nothing from a meta tag or a link that names no image', () => {
      expect(find('<meta name="description" content="/img/logo.png">')).toEqual([]);
      expect(find('<a href="/files/report.pdf">x</a>')).toEqual([]);
      expect(find('<a href="/about">x</a>')).toEqual([]);
    });

    it('keeps the position shape on an encoded path, where the spelling shape would lose it', () => {
      // The planner reads the rule against rewriting from the shape, so a spelling shape
      // here would let `optimize` convert the image a link preview names.
      const percent = find('<meta property="og:image" content="/img/my%20banner.png">');
      expect(percent.map(({ shape, ceiling }) => [shape, ceiling])).toEqual([
        ['html.meta.content.image', 'high'],
      ]);
      const entity = find('<a href="/gallery/a&amp;b.png">x</a>');
      expect(entity.map(({ shape, ceiling }) => [shape, ceiling])).toEqual([
        ['html.a.href.image', 'high'],
      ]);
    });

    it('reports a templated link to an image as unsafe rather than skipping it', () => {
      const references = find('<a href="{{ site.baseurl }}/img/team.jpg">x</a>');
      expect(references.map(({ shape, ceiling }) => [shape, ceiling])).toEqual([
        ['html.a.href.image', 'unsafe'],
      ]);
    });
  });

  describe('CSS carried inside HTML', () => {
    it('finds a url() in a style attribute', () => {
      const source = '<div style="background: url(bg.png)"></div>';
      expect(paths(source)).toEqual(['bg.png']);
      expect(slices(source)).toEqual(['bg.png']);
    });

    it('finds several declarations in one style attribute', () => {
      const source = '<div style="background: url(a.png); border-image: url(b.png)"></div>';
      expect(paths(source)).toEqual(['a.png', 'b.png']);
      expect(slices(source)).toEqual(['a.png', 'b.png']);
    });

    it('finds url() inside a style element', () => {
      const source = '<style>.a { background: url(inline.png); }</style>';
      expect(paths(source)).toEqual(['inline.png']);
      expect(slices(source)).toEqual(['inline.png']);
    });

    it('applies CSS rules inside a style element, including comments', () => {
      const source = '<style>/* url(fake.png) */ .a { background: url(real.png); }</style>';
      expect(paths(source)).toEqual(['real.png']);
      expect(slices(source)).toEqual(['real.png']);
    });

    it('keeps offsets correct for a style element late in a document', () => {
      const source = [
        '<!doctype html>',
        '<html><head><title>Hi</title>',
        '<style>.a { background: url(late.png); }</style>',
        '</head><body><img src="hero.png"></body></html>',
      ].join('\n');
      expect(paths(source)).toEqual(['late.png', 'hero.png']);
      expect(slices(source)).toEqual(['late.png', 'hero.png']);
    });
  });

  describe('never mistakes commented-out markup for markup', () => {
    it('ignores an img inside an HTML comment', () => {
      expect(paths('<!-- <img src="old.png"> -->\n<img src="new.png">')).toEqual(['new.png']);
    });

    it('ignores a whole commented-out block', () => {
      const source = '<!--\n<picture><source srcset="a.png"></picture>\n-->\n<img src="b.png">';
      expect(paths(source)).toEqual(['b.png']);
    });

    it('does not treat text content that looks like markup as markup', () => {
      expect(paths('<pre>&lt;img src="escaped.png"&gt;</pre><img src="real.png">')).toEqual([
        'real.png',
      ]);
    });
  });

  describe('ignores things that are not local files', () => {
    const cases: ReadonlyArray<[name: string, source: string]> = [
      ['data URIs', '<img src="data:image/png;base64,AAAA">'],
      ['https URLs', '<img src="https://cdn.example.com/x.png">'],
      ['protocol-relative URLs', '<img src="//cdn.example.com/x.png">'],
      ['fragments', '<img src="#anchor">'],
      ['an empty src', '<img src="">'],
      ['a valueless attribute', '<img src>'],
    ];

    it.each(cases)('%s', (_name, source) => {
      expect(find(source)).toEqual([]);
    });
  });

  describe('reports templated paths as unsafe rather than guessing', () => {
    const cases: ReadonlyArray<[name: string, source: string, note: RegExp]> = [
      ['Handlebars / Vue', '<img src="{{ image }}">', /Handlebars/],
      ['Liquid or Nunjucks tag', '<img src="{% asset_path %}">', /Liquid/],
      ['EJS or ERB', '<img src="<%= image %>">', /EJS/],
      ['template literal', '<img src="${image}">', /template literal/],
      ['inside a path', '<img src="/img/{{ slug }}.png">', /Handlebars/],
    ];

    it.each(cases)('%s', (_name, source, note) => {
      const references = find(source);
      expect(references).toHaveLength(1);
      expect(references[0]?.ceiling).toBe('unsafe');
      expect(references[0]?.note).toMatch(note);
    });

    it('reports a templated srcset candidate as unsafe but keeps the static one', () => {
      const references = find('<img srcset="{{ small }} 1x, big.png 2x">');
      expect(references.map((reference) => reference.ceiling)).toEqual(['unsafe', 'high']);
    });
  });

  describe('HTML character references', () => {
    /**
     * The decoded value is shorter than the source, so no range could point at a decoded
     * path. The range covers the encoded source text instead and `rawPath` is that text;
     * the resolver also tries the decoded spelling, and a rewrite re-encodes. So the
     * reference is located, resolvable and rewritable.
     */
    it('locates an entity-bearing path without decoding it into rawPath', () => {
      const source = '<img src="a&amp;b.png">';
      const references = find(source);
      expect(references).toHaveLength(1);
      const reference = references[0];
      if (reference === undefined) throw new Error('unreachable');
      expect(reference.ceiling).toBe('high');
      expect(reference.shape).toBe('path.charref');
      expect(source.slice(reference.start, reference.end)).toBe(reference.rawPath);
      expect(reference.rawPath).toBe('a&amp;b.png');
    });

    it('leaves an ordinary path untouched by that rule', () => {
      expect(find('<img src="a-b.png">')[0]?.ceiling).toBe('high');
    });

    // The HTML parser reads these as U+FFFD. A decoded spelling that differed from its
    // reading would have the attribute refused.
    it.each([
      ['zero', '<img src="/img/a&#0;b.png">'],
      ['a surrogate', '<img src="/img/a&#xD800;b.png">'],
      ['a number past the last code point', '<img src="/img/a&#x110000;b.png">'],
    ])('decodes a numeric reference to %s as the HTML parser does', (_name, source) => {
      const references = find(source);
      expect(references).toHaveLength(1);
      expect(references[0]?.ceiling).toBe('high');
    });

    // `high` means the decoding agreed with parse5's, the reading a browser gives the page.
    it('decodes each numeric reference from 128 to 159 as the HTML parser does', () => {
      for (let code = 128; code <= 159; code += 1) {
        for (const written of [`&#${code};`, `&#x${code.toString(16)};`]) {
          const [reference] = find(`<img src="/img/${written}uro.png">`);
          expect(reference?.ceiling, written).toBe('high');
        }
      }
    });

    /**
     * An escaped value matters only where the attribute is a reference position. Acted on
     * for every attribute, it would turn escaped `alt` text, other sites' links and
     * `<meta content>` values into `unsafe` references: failures the engine invented. See
     * "Character references in HTML attributes" in ARCHITECTURE.md.
     */
    describe('only where the attribute is a reference position at all', () => {
      const silent: ReadonlyArray<[name: string, source: string]> = [
        ['alt prose', '<img src="ok.png" alt="Rails Girls Baltimore: March 1st &amp; 2nd">'],
        ['an anchor href', '<a href="http://example.com/x?a=1&amp;b=2">x</a>'],
        ['a meta content', '<meta content="-----BEGIN PKCS7-----MIIHNwYJKoZIhvc&#43;Q==">'],
        ['a title attribute', '<div title="Tom &amp; Jerry"></div>'],
        ['a data attribute', '<div data-q="a=1&amp;b=2"></div>'],
        ['a stylesheet link', '<link rel="stylesheet" href="/s.css?a=1&amp;b=2">'],
      ];

      for (const [name, source] of silent) {
        it(`emits nothing for ${name}`, () => {
          expect(find(source).filter((reference) => reference.shape === 'path.charref')).toEqual(
            [],
          );
        });
      }

      it('still reports the one shape it was written for', () => {
        const references = find('<img src="./images/c&amp;s.png">');
        expect(references).toHaveLength(1);
        expect(references[0]?.shape).toBe('path.charref');
        expect(references[0]?.ceiling).toBe('high');
      });

      it('reports it in every other reference position too, not just img src', () => {
        for (const source of [
          '<video poster="./c&amp;s.png"></video>',
          '<object data="./c&amp;s.svg"></object>',
          '<link rel="icon" href="./c&amp;s.png">',
          '<input type="image" src="./c&amp;s.png">',
        ]) {
          expect(find(source).map((reference) => reference.shape)).toEqual(['path.charref']);
        }
      });

      /**
       * The external-URL test runs before the escaped-value rule, because an entity in a
       * query string does not make another host's file ours.
       */
      it('drops an escaped path that is somebody else’s, exactly as the unescaped one is', () => {
        expect(find('<img src="http://graph.facebook.com/p?type=square&width=100">')).toEqual([]);
        expect(find('<img src="http://graph.facebook.com/p?type=square&amp;width=100">')).toEqual(
          [],
        );
      });

      it('asks a srcset candidate by candidate, because one list is not one URL', () => {
        // All external: nothing of ours is being mislocated.
        expect(find('<img srcset="https://a/x.png?a=1&amp;b=2 1x, https://a/y.png 2x">')).toEqual(
          [],
        );
        // One local candidate: the attribute still holds a path we cannot locate.
        expect(
          find('<img srcset="https://a/x.png 1x, ./c&amp;s.png 2x">').map(
            (reference) => reference.shape,
          ),
        ).toEqual(['path.charref']);
      });

      /**
       * A style attribute holds CSS, so the external-URL test must not run on it:
       * `width: 100%` begins with letters and a colon, which reads as a URL scheme. A value
       * that starts with a space does not, so both spellings are here. The first also holds
       * a `url()`, so dropping the attribute and reading nothing both fail it.
       */
      it('reads a style attribute as CSS, not as a URL', () => {
        const unspaced =
          '<div style="width: 100%; font: 12px &quot;Inter&quot;; background: url(&quot;/img/a.png&quot;)"></div>';
        const spaced = '<div style=" width: 100%; font: 12px &quot;Inter&quot;"></div>';

        expect(paths(unspaced)).toEqual(['/img/a.png']);
        expect(find(spaced)).toEqual([]);
      });

      it('and one that cannot be read still says whether it could be hiding a reference', () => {
        // Not valid CSS even once decoded, so it is refused. The report reads the note to
        // tell a correct refusal from a miss, so the note has to say which this is.
        const references = find('<div style="margin 0 0 &quot;x&quot;"></div>');

        expect(references.map((reference) => reference.shape)).toEqual(['html.style.attribute']);
        expect(references[0]?.note).toContain(NO_REFERENCE_TO_FIND);
      });
    });
  });

  /**
   * Two kinds of unparseable style attribute are opposite outcomes. Without a url-taking
   * function there is nothing to find and refusing is correct (an author's missing colon,
   * `margin 0 0 0 15px`); with one, a reference may be hidden. The note says which, so the
   * report can classify the refusal without re-deriving the rule.
   */
  describe('an unparseable style attribute says whether it could be hiding a reference', () => {
    it('says there is nothing to find when no url-taking function is present', () => {
      const references = find('<div style="float:right; margin 0 0 0 15px; border:0;"></div>');
      expect(references).toHaveLength(1);
      expect(references[0]?.note).toContain(NO_REFERENCE_TO_FIND);
      expect(references[0]?.ceiling).toBe('unsafe');
    });

    it('says a reference may be hidden when one is present', () => {
      const references = find('<div style="margin 0 0 0 15px; background: url(/hero.png)"></div>');
      expect(references).toHaveLength(1);
      expect(references[0]?.note).toMatch(/a reference may be hidden/);
    });

    it('counts image-set as a url-taking function too', () => {
      const references = find(
        '<div style="margin 0 0 0; background: -webkit-image-set(url(/a.png) 1x)"></div>',
      );
      expect(references[0]?.note).toMatch(/a reference may be hidden/);
    });

    it('leaves a well-formed style attribute alone', () => {
      expect(paths('<div style="background: url(/hero.png)"></div>')).toEqual(['/hero.png']);
    });
  });

  /**
   * A path spelled with character references resolves decoded, while its range still
   * covers the encoded source text, so `source.slice(start, end) === rawPath` holds.
   */
  describe('character-reference paths are located, decoded and re-encoded', () => {
    for (const written of ['a&amp;b.png', 'a&#38;b.png', 'a&#x26;b.png', 'caf&eacute;.png']) {
      it(`locates ${written} exactly, without decoding into rawPath`, () => {
        const source = `<img src="/gallery/${written}">`;
        const references = find(source);
        expect(references).toHaveLength(1);
        const reference = references[0];
        if (reference === undefined) throw new Error('unreachable');
        expect(reference.shape).toBe('path.charref');
        expect(reference.ceiling).toBe('high');
        // The range invariant, asserted here rather than assumed.
        expect(source.slice(reference.start, reference.end)).toBe(reference.rawPath);
        expect(reference.rawPath).toBe(`/gallery/${written}`);
      });
    }

    it('refuses a reference it cannot fully decode rather than risking a false broken', () => {
      // parse5 decodes the legacy `&eacute` without its semicolon here; our decoder does not.
      const references = find('<img src="/gallery/caf&eacute.png">');
      expect(references).toHaveLength(1);
      expect(references[0]?.ceiling).toBe('unsafe');
      expect(references[0]?.note).toMatch(/character references/);
    });

    // A lookup of any other spelling could report a file that exists as broken. parse5 also
    // decodes the legacy `&copy` before the dot, and the resolver decodes a reference or a
    // percent-escape, never both.
    it.each(['caf&eacute;&copy.png', 'caf&eacute;%20x.png'])(
      'refuses %s, whose decoded spelling is not what a browser reads',
      (written) => {
        const references = find(`<img src="/gallery/${written}">`);
        expect(references).toHaveLength(1);
        expect(references[0]?.ceiling).toBe('unsafe');
      },
    );
  });

  /**
   * A browser decodes the attribute before reading it as CSS. Read as source text,
   * `url(&quot;/logo.png&quot;)` holds one unquoted token ending in `.png&quot;`, not an
   * image extension, so the resolver would drop it. The decoded text parses, but its
   * offsets are not the file's, so the decoder keeps a map back to the source. See
   * "Character references in HTML attributes" in ARCHITECTURE.md.
   */
  describe('a style attribute whose CSS is spelled with character references', () => {
    it('reads the CSS a browser sees, and points at the source text', () => {
      const source = '<span style="background-image: url(&quot;/logo.png&quot;)"></span>';
      const references = find(source);

      expect(references).toHaveLength(1);
      const reference = references[0];
      if (reference === undefined) throw new Error('unreachable');
      expect(reference.rawPath).toBe('/logo.png');
      expect(reference.ceiling).toBe('high');
      // The range invariant, asserted rather than assumed: here the offsets come from
      // decoded text and are mapped back, so this is where it can fail.
      expect(source.slice(reference.start, reference.end)).toBe(reference.rawPath);
    });

    it('handles a numeric reference for the quote too', () => {
      const source = '<span style="background: url(&#34;/logo.png&#34;)"></span>';
      const references = find(source);

      expect(references.map((reference) => reference.rawPath)).toEqual(['/logo.png']);
      expect(source.slice(references[0]?.start ?? 0, references[0]?.end ?? 0)).toBe('/logo.png');
    });

    it('keeps the path encoded when the path itself carries a reference', () => {
      // The delimiters decode; the path does not. `rawPath` stays the source text, and
      // the resolver tries its decoded spelling as it does for any escaped path.
      const source = '<span style="background: url(&quot;/a&amp;b.png&quot;)"></span>';
      const references = find(source);

      expect(references).toHaveLength(1);
      expect(references[0]?.rawPath).toBe('/a&amp;b.png');
      expect(source.slice(references[0]?.start ?? 0, references[0]?.end ?? 0)).toBe('/a&amp;b.png');
    });

    /**
     * This check is what makes our decoder safe beside parse5, which also decodes some
     * legacy names written without their semicolon. Where the two disagree our offsets would
     * describe text the browser never saw, so the attribute is refused: the worst case is a
     * refusal, never a wrong range.
     */
    it('refuses when our decoder and the parser disagree', () => {
      const source = '<span style="background: url(&quot;/caf&eacute.png&quot;)"></span>';
      const references = find(source);

      expect(references).toHaveLength(1);
      expect(references[0]?.ceiling).toBe('unsafe');
      expect(references[0]?.shape).toBe('html.style.attribute');
    });

    it('still refuses an entity-escaped attribute that is not parseable CSS', () => {
      const references = find('<span style="margin 0 0 &quot;x&quot;"></span>');

      expect(references).toHaveLength(1);
      expect(references[0]?.ceiling).toBe('unsafe');
      expect(references[0]?.note).toContain(NO_REFERENCE_TO_FIND);
    });

    /**
     * This emoji, U+1F600, is two UTF-16 code units, and one character reference can spell
     * it. Both units map to the reference's start, so the text after it keeps its offsets.
     */
    for (const written of ['&#x1F600;', '&#128512;']) {
      it(`keeps the path on its own source range after an emoji written as ${written}`, () => {
        const source = `<div style="--icon: &quot;${written}&quot;; background: url(&quot;/img/a.png&quot;)"></div>`;
        const references = find(source);

        expect(references).toHaveLength(1);
        const reference = references[0];
        if (reference === undefined) throw new Error('unreachable');
        expect(reference.rawPath).toBe('/img/a.png');
        expect(reference.ceiling).toBe('high');
        expect(source.slice(reference.start, reference.end)).toBe(reference.rawPath);
      });
    }

    it('keeps the path and its query apart after an emoji reference', () => {
      // One character late, the range would read `img/a.png?`, still an image once the query
      // is split off, so the resolver would look it up beside the page and report it broken.
      const source =
        '<div style="--icon: &quot;&#x1F600;&quot;; background: url(&quot;/img/a.png?v=2&quot;)"></div>';

      expect(paths(source)).toEqual(['/img/a.png']);
      expect(slices(source)).toEqual(['/img/a.png']);
    });

    const emoji = String.fromCodePoint(0x1f600);
    const maps: ReadonlyArray<[name: string, source: string, text: string, map: number[]]> = [
      ['a named reference', 'a&amp;b', 'a&b', [0, 1, 6, 7]],
      ['an emoji as a hex reference', 'a&#x1F600;b', `a${emoji}b`, [0, 1, 1, 10, 11]],
      ['an emoji as a decimal reference', 'a&#128512;b', `a${emoji}b`, [0, 1, 1, 10, 11]],
      ['a literal emoji before a reference', `${emoji}&amp;b`, `${emoji}&b`, [0, 1, 2, 7, 8]],
    ];

    it.each(maps)(
      'maps each decoded UTF-16 code unit to the source offset it came from: %s',
      (_name, source, text, map) => {
        expect(decodeCharacterReferencesWithMap(source)).toEqual({ text, map });
      },
    );
  });

  describe('a value that spans lines in a file whose lines end with CR LF', () => {
    // The HTML parser reads each CR LF pair, and each lone CR, as one LF before tokenising, so
    // parse5's value lacks the CRs its source text holds.
    it('reads each candidate of a srcset over two lines', () => {
      const source = '<img alt="" srcset="/img/a.png 1x,\r\n     /img/b.png 2x">';
      const references = find(source);

      expect(references.map((reference) => [reference.rawPath, reference.ceiling])).toEqual([
        ['/img/a.png', 'high'],
        ['/img/b.png', 'high'],
      ]);
      expect(slices(source)).toEqual(['/img/a.png', '/img/b.png']);
    });

    it('reads a srcset whose lines end with a lone CR, which the parser reads as LF too', () => {
      const source = '<img alt="" srcset="/img/a.png 1x,\r     /img/b.png 2x">';

      expect(paths(source)).toEqual(['/img/a.png', '/img/b.png']);
      expect(slices(source)).toEqual(['/img/a.png', '/img/b.png']);
    });

    it('reads the url() of a style attribute over three lines', () => {
      const source = '<div style="\r\n  background-image: url(/img/c.png);\r\n  color: red"></div>';
      const references = find(source);

      expect(references.map((reference) => [reference.rawPath, reference.ceiling])).toEqual([
        ['/img/c.png', 'high'],
      ]);
      expect(slices(source)).toEqual(['/img/c.png']);
    });

    it('reads a style attribute over three lines that also holds character references', () => {
      // Its decoded CSS keeps the CRs, so it too is compared with parse5's value as the parser
      // reads line endings.
      const source =
        '<div style="\r\n  background-image: url(&quot;/img/c.png&quot;);\r\n  color: red"></div>';
      const references = find(source);

      expect(references.map((reference) => [reference.rawPath, reference.ceiling])).toEqual([
        ['/img/c.png', 'high'],
      ]);
      expect(slices(source)).toEqual(['/img/c.png']);
    });

    it('reads a single URL whose value ends with the line break, not as character references', () => {
      const source = '<img src="./img/logo.png\r\n" alt="">';
      const references = find(source);

      expect(
        references.map((reference) => [reference.rawPath, reference.ceiling, reference.note]),
      ).toEqual([['./img/logo.png', 'high', undefined]]);
      expect(slices(source)).toEqual(['./img/logo.png']);
    });

    it('keeps a single URL with a line break inside it unsafe, and says why', () => {
      const [reference] = find('<img src="./img/\r\nlogo.png">');

      expect([reference?.shape, reference?.ceiling]).toEqual(['html.img.src', 'unsafe']);
      expect(reference?.note).toContain('line break');
      expect(reference?.note).not.toContain('character references');
    });
  });

  describe('whitespace around a single URL', () => {
    // A browser reads these values as URLs, and the URL parser strips the C0 controls and
    // spaces at either end of a URL and removes every tab and line break inside it.
    it('reads a URL whose value ends with a line break, and ranges over the URL alone', () => {
      const source = '<img alt="" src="/img/a.png\n">';
      const references = find(source);

      expect(references.map((reference) => [reference.rawPath, reference.ceiling])).toEqual([
        ['/img/a.png', 'high'],
      ]);
      expect(slices(source)).toEqual(['/img/a.png']);
    });

    it('reads a URL whose value starts with a line break and spaces', () => {
      const source = '<img alt="" src="\n      /img/a.png">';

      const references = find(source);

      expect(references.map((reference) => [reference.rawPath, reference.ceiling])).toEqual([
        ['/img/a.png', 'high'],
      ]);
      expect(slices(source)).toEqual(['/img/a.png']);
    });

    it('reads a poster, an icon and a link to an image the same way', () => {
      const source = [
        '<video poster=" /img/poster.png\t"></video>',
        '<link rel="icon" href="\n  /favicon.png">',
        '<a href="/img/full.png\n">full size</a>',
      ].join('\n');

      expect(find(source).map((reference) => [reference.rawPath, reference.shape])).toEqual([
        ['/img/poster.png', 'html.video.poster'],
        ['/favicon.png', 'html.link.href.icon'],
        ['/img/full.png', 'html.a.href.image'],
      ]);
      expect(slices(source)).toEqual(['/img/poster.png', '/favicon.png', '/img/full.png']);
    });

    it('rewrites the URL and leaves the whitespace around it in place', () => {
      const source = '<img src="\n  /img/a.png\n">';
      const [reference] = find(source);
      const rewritten = htmlAdapter.rewrite({
        text: source,
        edits: [
          { start: reference?.start ?? 0, end: reference?.end ?? 0, replacement: '/img/a.webp' },
        ],
      });

      expect(rewritten).toBe('<img src="\n  /img/a.webp\n">');
    });

    it('keeps a URL with a tab or line break inside it unsafe, since no range spells what a browser reads', () => {
      for (const source of ['<img src="/img/\nlogo.png">', '<img src="/img/\tlogo.png">']) {
        const references = find(source);

        expect(
          references.map((reference) => [reference.shape, reference.ceiling]),
          source,
        ).toEqual([['html.img.src', 'unsafe']]);
      }
    });

    it('keeps unsafe a URL whose character references spell whitespace the URL parser drops', () => {
      // parse5 decodes these to a line break and a space, which the URL parser then removes,
      // so the decoded spelling is not the path a browser loads.
      for (const source of ['<img src="/img/a&#10;b.png">', '<img src="&#32;/img/a.png">']) {
        const [reference] = find(source);

        expect([reference?.shape, reference?.ceiling], source).toEqual(['path.charref', 'unsafe']);
      }
    });

    it('finds nothing in a value that is only whitespace, or another host with some around it', () => {
      expect(find('<img src=" \n ">')).toEqual([]);
      expect(find('<img src="\n  https://cdn.example.com/a.png">')).toEqual([]);
    });
  });

  describe('query strings', () => {
    it('reports the path alone so a rewrite preserves the suffix', () => {
      const source = '<img src="hero.png?v=2">';
      expect(paths(source)).toEqual(['hero.png']);
      expect(slices(source)).toEqual(['hero.png']);
      const rewritten = htmlAdapter.rewrite({
        text: source,
        edits: find(source).map((reference) => ({
          start: reference.start,
          end: reference.end,
          replacement: 'hero.webp',
        })),
      });
      expect(rewritten).toBe('<img src="hero.webp?v=2">');
    });
  });

  describe('offsets are UTF-16 code units', () => {
    it('stays aligned after an emoji earlier in the document', () => {
      const source = '<p>🎉 launch</p><img src="hero.png">';
      expect(slices(source)).toEqual(['hero.png']);
    });

    it('handles a non-ASCII path', () => {
      const source = '<img src="héro-café.png">';
      expect(paths(source)).toEqual(['héro-café.png']);
      expect(slices(source)).toEqual(['héro-café.png']);
    });
  });

  describe('malformed documents', () => {
    it('recovers from an unclosed tag, because HTML has no parse errors', () => {
      expect(paths('<div><img src="hero.png">')).toEqual(['hero.png']);
    });

    it('finds references in a document with no html or body element', () => {
      expect(paths('<img src="hero.png">')).toEqual(['hero.png']);
    });

    it('finds a value whose closing quote runs straight into the next attribute', () => {
      // The specification reads the value up to its quote and starts the next attribute
      // there. parse5 does too, but the range it records for such an attribute ends at the name.
      const source =
        '<img src="a.png"alt="x"><meta property="og:image" content="c.png"data-x>' +
        "<img src='b.png'alt=''>";
      expect(paths(source)).toEqual(['a.png', 'c.png', 'b.png']);
      expect(slices(source)).toEqual(['a.png', 'c.png', 'b.png']);
    });

    it('leaves a valueless attribute valueless when another attribute follows it', () => {
      expect(paths('<img src alt="hero.png"><img hidden src="a.png">')).toEqual(['a.png']);
    });

    it('names where a style attribute fails to parse in the file, not in the attribute', () => {
      const source = '<p>one</p>\n<p>two</p>\n<p style="color: red; margin 0.5em">x</p>';
      expect(find(source)[0]?.note).toContain('at line 3, column 23');
    });

    it('names where a <style> element fails to parse in the file, not in the element', () => {
      const source = '<p>one</p>\n<style>\n  .a { color: red }\n  .b { margin 0.5em }\n</style>\n';
      expect(find(source)[0]?.note).toContain('at line 4, column 8');
    });

    it('refuses a closed <style> whose CSS does not parse, and reads the page after it', () => {
      const source =
        '<style>\n.a { //*radius: 50%; }\n</style>\n' +
        '<meta property="og:image" content="/og.png">\n<img src="b.png">';
      const references = find(source);
      expect(references.map((reference) => reference.rawPath)).toEqual([
        '\n.a { //*radius: 50%; }\n',
        '/og.png',
        'b.png',
      ]);
      expect(references[0]).toMatchObject({
        shape: 'html.style.element',
        ceiling: 'unsafe',
        unread: true,
      });
      expect(references[0]?.note).toContain(NO_REFERENCE_TO_FIND);
    });

    it('still fails the page at a <style> never closed, whose CSS is the rest of it', () => {
      expect(() => find('<p>a</p>\n<style>\n.a { //*x }\n<img src="b.png">')).toThrow(
        'The <style> on line 2 is never closed',
      );
    });

    it('reports an unparseable style attribute instead of dropping it', () => {
      const references = find('<div style="background: url(hero.png"></div>');
      expect(references).toHaveLength(1);
      expect(references[0]?.ceiling).toBe('unsafe');
      expect(references[0]?.note).toMatch(/could not parse the style attribute/);
    });
  });

  describe('is pure and deterministic', () => {
    it('returns the same result for the same input', () => {
      const source = '<img src="a.png" srcset="b.png 2x"><style>.c{background:url(c.png)}</style>';
      expect(find(source)).toEqual(find(source));
    });

    it('returns references sorted by position', () => {
      const source = '<style>.a{background:url(second.png)}</style><img src="third.png">';
      const starts = find(source).map((reference) => reference.start);
      expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    });

    it('records the file it was given', () => {
      expect(find('<img src="a.png">', '/project/pages/about.html')[0]?.file).toBe(
        '/project/pages/about.html',
      );
    });
  });

  describe('rewrite', () => {
    it('replaces several paths across attributes and inline CSS in one pass', () => {
      const source = '<style>.a{background:url(a.png)}</style><img src="b.png">';
      const rewritten = htmlAdapter.rewrite({
        text: source,
        edits: find(source).map((reference) => ({
          start: reference.start,
          end: reference.end,
          replacement: reference.rawPath.replace('.png', '.webp'),
        })),
      });
      expect(rewritten).toBe('<style>.a{background:url(a.webp)}</style><img src="b.webp">');
    });

    it('is a no-op with no edits', () => {
      const source = '<img src="hero.png">';
      expect(htmlAdapter.rewrite({ text: source, edits: [] })).toBe(source);
    });
  });

  const NEWLINE = String.fromCharCode(10);

  describe('a <style> block built by a template', () => {
    // Eleventy, Jekyll, Hugo, Nunjucks and Liquid sites inline conditional CSS this way.
    // PostCSS fails on the `%`, and a CSS failure inside `<style>` fails the whole
    // document, taking the references outside the block with it.

    it('does not hand template syntax to the CSS parser', () => {
      const text = [
        '<style>',
        '{% if env == "production" %}',
        '  .a { background: url(./hero.png); }',
        '{% endif %}',
        '</style>',
      ].join(NEWLINE);

      expect(() => htmlAdapter.findReferences({ file: '/p/page.html', text })).not.toThrow();
    });

    it('reports it as unsafe rather than dropping it', () => {
      // Declined, so it reaches the report with a reason: the same one a templated path
      // gets.
      const text = ['<style>', '{% if x %}.a{}{% endif %}', '</style>'].join(NEWLINE);
      const references = htmlAdapter.findReferences({ file: '/p/page.html', text });

      expect(references).toHaveLength(1);
      expect(references[0]?.ceiling).toBe('unsafe');
      expect(references[0]?.note).toContain('built by a template');
    });

    it('still scans a <style> block that is ordinary CSS', () => {
      // The control, and the over-fix this is closest to: a plain block must still
      // have its url() read.
      const text = ['<style>', '  .a { background: url(./hero.png); }', '</style>'].join(NEWLINE);

      expect(
        htmlAdapter.findReferences({ file: '/p/page.html', text }).map((r) => r.rawPath),
      ).toEqual(['./hero.png']);
    });
  });

  /**
   * An `<svg>` inside an HTML document is not an `.svg` file, so no SVG adapter would reach
   * it: this adapter reads its `<image>` and `<feImage>` references itself.
   */
  describe('inline SVG', () => {
    const cases: ReadonlyArray<[name: string, source: string, expected: readonly string[]]> = [
      ['image href', '<svg><image href="/a/hero.png"/></svg>', ['/a/hero.png']],
      // The SVG 1.1 spelling, still overwhelmingly what shipped markup contains.
      ['image xlink:href', '<svg><image xlink:href="/a/hero.png"/></svg>', ['/a/hero.png']],
      [
        'feImage href',
        '<svg><filter><feImage href="/a/hero.png"/></filter></svg>',
        ['/a/hero.png'],
      ],
    ];

    it.each(cases)('reads %s', (_name, source, expected) => {
      expect(paths(source)).toEqual(expected);
      expect(slices(source)).toEqual(expected);
    });

    /**
     * parse5 splits `xlink:href` into `{ name: 'href', prefix: 'xlink' }` but keys its
     * source-location map by the written spelling, `'xlink:href'`. Looked up by the bare
     * name, the location is missing and the attribute is skipped with no reason recorded.
     */
    it('finds the location of a namespaced attribute, which is keyed by its spelling', () => {
      const source = '<svg><image xlink:href="/a/hero.png"/></svg>';
      const references = find(source);
      expect(references).toHaveLength(1);
      expect(source.slice(references[0]?.start, references[0]?.end)).toBe('/a/hero.png');
    });

    it('leaves a bare <image href> alone, because the parser makes it an <img>', () => {
      // Not a gap. Outside foreign content the HTML spec renames `<image>` to `<img>`,
      // and `href` is not an `<img>` attribute, so the markup displays nothing and there
      // is no reference to find.
      expect(find('<image href="/a/hero.png">')).toEqual([]);
    });

    it('leaves <use href> alone, deliberately', () => {
      // `<use href="#icon">`, the commonest form, names an element in the same document,
      // and `/a/sprite.svg#icon` names a vector Upfly neither converts nor deletes. Pinned
      // so that reading `<use>` stays a decision.
      expect(find('<svg><use href="#icon"/></svg>')).toEqual([]);
      expect(find('<svg><use href="/a/sprite.svg#icon"/></svg>')).toEqual([]);
    });
  });

  /**
   * Files uploaded through a CMS often carry spaces, and a path cut at the space leaves its
   * image looking unreferenced. These cases pin the positions that read the whole name.
   */
  describe('a space in a filename', () => {
    const cases: ReadonlyArray<[name: string, source: string, expected: readonly string[]]> = [
      ['img src', '<img src="/a/Firing Practice.webp">', ['/a/Firing Practice.webp']],
      [
        'style attribute url()',
        '<div style="background:url(\'/a/Firing Practice.webp\')"></div>',
        ['/a/Firing Practice.webp'],
      ],
      ['link rel=icon', '<link rel="icon" href="/a/My Logo.png">', ['/a/My Logo.png']],
    ];

    it.each(cases)('keeps reading %s', (_name, source, expected) => {
      expect(paths(source)).toEqual(expected);
      expect(slices(source)).toEqual(expected);
    });

    it('still splits srcset at the space, which is what the spec says', () => {
      // Not a defect. In `srcset` a space separates the URL from its descriptor, so a
      // filename with a real space has to be percent-encoded. The browser reads `/a/My`
      // here too, and agreeing with the browser is the correct behaviour.
      expect(paths('<img srcset="/a/My Photo.png 2x">')).toEqual(['/a/My']);
    });
  });
});

/**
 * With scripting enabled, parse5's default, the HTML spec parses a `<noscript>` element's
 * children as raw text, so the `<img>` inside never becomes an element. `<noscript><img>` is
 * the standard lazy-loading fallback: missed, it would be left naming an original that
 * `optimize --replace` removed, breaking the one render with no script to recover.
 */
describe('an image inside <noscript> is markup, not text', () => {
  it('finds it', () => {
    const source = '<figure><noscript><img src="/img/hero.png"></noscript></figure>';

    expect(find(source).map((reference) => reference.rawPath)).toEqual(['/img/hero.png']);
  });

  it('keeps finding the ones around it (the control)', () => {
    // A parser option is a blunt instrument: this catches a change that fixes noscript
    // and breaks ordinary markup.
    const source =
      '<img src="/a.png">\n<noscript><img src="/b.png"></noscript>\n<img src="/c.png">';

    expect(find(source).map((reference) => reference.rawPath)).toEqual([
      '/a.png',
      '/b.png',
      '/c.png',
    ]);
  });

  it('reads a <noscript> in the head, where the parser takes a different branch', () => {
    // `scriptingEnabled` changes head parsing as well as body parsing, and a `<noscript>`
    // in the head is where a real document puts a tracking pixel fallback.
    const source =
      '<html><head><noscript><link rel="icon" href="/icon.png"></noscript></head><body></body></html>';

    expect(find(source).map((reference) => reference.rawPath)).toEqual(['/icon.png']);
  });
});

/**
 * parse5 keeps a template's markup in a separate `content` fragment, not among the
 * element's children. That markup is live: a script clones it into the page, and a
 * declarative shadow root (`shadowrootmode`) renders it with no script at all.
 */
describe("a <template>'s content is read like the markup around it", () => {
  const cases: ReadonlyArray<[name: string, source: string, expected: readonly string[]]> = [
    ['an image in a template', '<template><img src="/img/hero.png"></template>', ['/img/hero.png']],
    [
      'a declarative shadow root',
      '<div><template shadowrootmode="open"><img src="/shadow.png"></template></div>',
      ['/shadow.png'],
    ],
    [
      'a template nested in a template',
      '<template><div><template><img src="/deep.png"></template></div></template>',
      ['/deep.png'],
    ],
    [
      'a <style> in a template',
      '<template><style>.a { background: url(/in-style.png); }</style></template>',
      ['/in-style.png'],
    ],
    [
      'a table row in a template, which the parser allows only there',
      '<template><tr><td><img src="/cell.png"></td></tr></template>',
      ['/cell.png'],
    ],
    [
      'a template in the head',
      '<html><head><template><link rel="icon" href="/icon.png"></template></head></html>',
      ['/icon.png'],
    ],
  ];

  it.each(cases)('finds %s, with its exact range', (_name, source, expected) => {
    expect(paths(source)).toEqual([...expected]);
    expect(slices(source)).toEqual([...expected]);
  });

  it('keeps the references around a template in document order', () => {
    const source = '<img src="/a.png"><template><img src="/b.png"></template><img src="/c.png">';

    expect(paths(source)).toEqual(['/a.png', '/b.png', '/c.png']);
  });

  it('rewrites a path inside a template where it stands', () => {
    const source = '<template><p><img src="/img/hero.png"></p></template>';
    const rewritten = htmlAdapter.rewrite({
      text: source,
      edits: find(source).map((reference) => ({
        start: reference.start,
        end: reference.end,
        replacement: '/img/hero.webp',
      })),
    });

    expect(rewritten).toBe('<template><p><img src="/img/hero.webp"></p></template>');
  });

  it('still reads the children of a <template> inside SVG, which has no content fragment', () => {
    // In foreign content the tag makes an ordinary element, so reading the fragment has to
    // come in addition to reading children, never instead of it.
    expect(paths('<svg><template><image href="/svg.png"/></template></svg>')).toEqual(['/svg.png']);
  });
});
