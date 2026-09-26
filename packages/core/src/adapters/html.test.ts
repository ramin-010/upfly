import { describe, expect, it } from 'vitest';
import type { RawReference } from '../types.js';
import { htmlAdapter } from './html.js';

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
       * that starts with a space does not, so both spellings are here. Each decodes to
       * valid CSS with no `url()`, so neither yields a reference.
       */
      it('leaves a style attribute alone: its text is CSS, not a URL', () => {
        for (const source of [
          '<div style="width: 100%; font: 12px &quot;Inter&quot;"></div>',
          '<div style=" width: 100%; font: 12px &quot;Inter&quot;"></div>',
        ]) {
          expect(find(source)).toEqual([]);
        }
      });

      it('and one that cannot be read still says whether it could be hiding a reference', () => {
        // Not valid CSS even once decoded, so it is refused. The report reads the note to
        // tell a correct refusal from a miss, so the note has to say which this is.
        const references = find('<div style="margin 0 0 &quot;x&quot;"></div>');

        expect(references.map((reference) => reference.shape)).toEqual(['html.style.attribute']);
        expect(references[0]?.note).toMatch(/no reference in it to find/);
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
      expect(references[0]?.note).toMatch(/no reference in it to find/);
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
    for (const written of ['a&amp;b.png', 'a&#38;b.png', 'a&#x26;b.png']) {
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
      const references = find('<img src="/gallery/caf&eacute;.png">');
      expect(references).toHaveLength(1);
      expect(references[0]?.ceiling).toBe('unsafe');
      expect(references[0]?.note).toMatch(/character references/);
    });
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
     * This check is what makes a five-entity decoder safe beside parse5, which knows every
     * named reference. Where the two disagree our offsets would describe text the browser
     * never saw, so the attribute is refused: the worst case is a refusal, never a wrong
     * range.
     */
    it('refuses when our decoder and the parser disagree', () => {
      const source = '<span style="background: url(&quot;/caf&eacute;.png&quot;)"></span>';
      const references = find(source);

      expect(references).toHaveLength(1);
      expect(references[0]?.ceiling).toBe('unsafe');
      expect(references[0]?.shape).toBe('html.style.attribute');
    });

    it('still refuses an entity-escaped attribute that is not parseable CSS', () => {
      const references = find('<span style="margin 0 0 &quot;x&quot;"></span>');

      expect(references).toHaveLength(1);
      expect(references[0]?.ceiling).toBe('unsafe');
      expect(references[0]?.note).toMatch(/no reference in it to find/);
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

  it('does not yet read <template>, and that gap is pinned rather than silent', () => {
    // parse5 puts a template's children in a separate `content` fragment that `walk` never
    // descends into, a different mechanism from noscript's, which the parser option does
    // not reach. The assertion pins today's wrong behaviour, so whoever closes the gap sees
    // this test fail and updates it.
    expect(find('<template><img src="/img/hero.png"></template>')).toEqual([]);
  });
});
