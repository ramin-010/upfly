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
     * ⚠️ **This test asserted `unsafe` until R118, and the change is a RULING rather
     * than a relaxation.** The reasoning it carried — *the decoded value is shorter than
     * the source, so no range points at the path* — was only ever an argument against
     * storing the DECODED text. The range covers the ENCODED source text and `rawPath` is
     * that text, so the invariant holds exactly as before; what changed is that the
     * resolver now also tries the decoded spelling and `relocate` re-encodes on the way
     * out. The reference is located, resolvable and rewritable.
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
     * R99. The guard above is right about the cases it was written for and it used to
     * fire on **every attribute of every element**, before anything decided whether the
     * attribute was a reference position at all.
     *
     * Measured across the five validation repositories: **536 references carried that
     * reason and 535 were phantoms.** 402 of them were absolute URLs in real reference
     * positions, 133 were attributes that are not references at all — `alt` prose, an
     * `<a href>`, a PKCS7 certificate blob in a `<meta content>` — and exactly one was a
     * genuine local image path with a character reference in it.
     *
     * 🔴 **The shape of the bug is the INVERSE of the one rule 9 guards.** Rule 9 stops
     * us silently DROPPING a reference; this silently INVENTED them, and every invention
     * landed in `unsafe` where it was counted as something we could not handle. A tool
     * that manufactures its own failures measures itself as worse than it is, which is
     * why it went unexamined: the number moved in the direction that reads as humility.
     */
    describe('R99 — only where the attribute is a reference position at all', () => {
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
        // `unsafe` until R118 made this spelling resolvable. See the block below.
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
       * R99's second half, and the larger one: the guard bypassed `isExternalUrl` as
       * well as the position test. **An entity in a query string does not make another
       * host's file ours**, so the answer must not depend on the spelling.
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
       * 🔴 The external-URL test must not run on a style attribute, and this test is
       * here because the first version of the fix ran it and dropped the attribute
       * silently. `URL_SCHEME` is *letters then a colon*, so `width: 100%` reads as a
       * scheme.
       *
       * ⚠️ **Both spellings, because the bug depended on WHITESPACE.** The only two real
       * cases in the validation corpus begin with a space, which does not match the
       * scheme pattern — so they went on being emitted and the measurement looked clean
       * while the ordinary spelling was being thrown away.
       */
      it('leaves a style attribute alone — its text is CSS, not a URL', () => {
        // ⚠️ **R123 SUPERSEDED THE OUTCOME AND NOT THE POINT.** The assertion used to be
        // that this emits an UNSAFE reference, because the attribute could not be read.
        // It can be read now: it decodes to `width: 100%; font: 12px "Inter"`, parses,
        // holds no `url()`, and therefore yields nothing at all — exactly as the
        // unescaped spelling does. A valid style attribute with no `url()` was never a
        // reference, and the entry it used to produce described our inability rather than
        // its contents.
        //
        // 🔴 What this test is still FOR is unchanged: the external-URL test must not run
        // here, because `URL_SCHEME` is *letters then a colon* and `width: 100%` reads as
        // a scheme. Both spellings stay, because that bug depended on whitespace.
        for (const source of [
          '<div style="width: 100%; font: 12px &quot;Inter&quot;"></div>',
          '<div style=" width: 100%; font: 12px &quot;Inter&quot;"></div>',
        ]) {
          expect(find(source)).toEqual([]);
        }
      });

      it('and one that cannot be read still says whether it could be hiding a reference', () => {
        // The refusal path is still reachable — this is not parseable CSS — and R111's
        // classification still depends on the sentence it carries.
        const references = find('<div style="margin 0 0 &quot;x&quot;"></div>');

        expect(references.map((reference) => reference.shape)).toEqual(['html.style.attribute']);
        expect(references[0]?.note).toMatch(/no reference in it to find/);
      });
    });
  });

  /**
   * R118. The two kinds of unparseable style attribute are OPPOSITE outcomes and the note
   * has to say which, because the report classifies from it and must not re-derive the
   * rule (R111).
   *
   * Measured on the five validation repositories: 33 style attributes fail to parse and
   * **none of them contains a `url()`**. They are an author's missing colon
   * (`margin 0 0 0 15px`) and two Astro `style={{...}}` expressions. Refusing those is a
   * correct refusal \u2014 there is no reference in them to find.
   */
  describe('an unparseable style attribute says whether it could be hiding a reference', () => {
    it('says there is nothing to find when no url-taking function is present', () => {
      const references = find('<div style="float:right; margin 0 0 0 15px; border:0;"></div>');
      expect(references).toHaveLength(1);
      expect(references[0]?.note).toMatch(/no reference in it to find/);
      expect(references[0]?.ceiling).toBe('unsafe');
    });

    it('says a reference may be hidden when one IS present', () => {
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
   * R118 \u2014 a path spelled with character references is resolvable, and the RANGE still
   * covers the encoded source text so the invariant is untouched.
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
   * R123 — the last member of the entity family, and the one that MOVES A RANGE.
   *
   * 🔴 `style="background-image: url(&quot;/logo.png&quot;)"` is CSS the HTML parser has
   * already decoded, so handing PostCSS the SOURCE text gives `&quot;/logo.png&quot;` as
   * one unquoted token — extension `.png&quot;`, dropped by rung 3. The decoded text
   * parses correctly and returns offsets into a string that is not the file, so the
   * decode carries a MAP back.
   *
   * ⚠️ **The path itself is plain ASCII and contiguous in the source; only the
   * DELIMITERS are encoded.** That is what makes this member the easiest one and the
   * right one to design against.
   */
  describe('R123 — a style attribute whose CSS is spelled with character references', () => {
    it('reads the CSS a browser sees, and points at the SOURCE text', () => {
      const source = '<span style="background-image: url(&quot;/logo.png&quot;)"></span>';
      const references = find(source);

      expect(references).toHaveLength(1);
      const reference = references[0];
      if (reference === undefined) throw new Error('unreachable');
      expect(reference.rawPath).toBe('/logo.png');
      expect(reference.ceiling).toBe('high');
      // The invariant, asserted rather than assumed. This is the only change in the
      // family that moves a range, so it is the only one where this can fail.
      expect(source.slice(reference.start, reference.end)).toBe(reference.rawPath);
    });

    it('handles a numeric reference for the quote too', () => {
      const source = '<span style="background: url(&#34;/logo.png&#34;)"></span>';
      const references = find(source);

      expect(references.map((reference) => reference.rawPath)).toEqual(['/logo.png']);
      expect(source.slice(references[0]?.start ?? 0, references[0]?.end ?? 0)).toBe('/logo.png');
    });

    it('keeps the path ENCODED when the path itself carries a reference', () => {
      // The delimiters decode; the path does not. `rawPath` stays the source text and
      // R118's spelling machinery resolves it — the two changes compose rather than
      // fighting.
      const source = '<span style="background: url(&quot;/a&amp;b.png&quot;)"></span>';
      const references = find(source);

      expect(references).toHaveLength(1);
      expect(references[0]?.rawPath).toBe('/a&amp;b.png');
      expect(source.slice(references[0]?.start ?? 0, references[0]?.end ?? 0)).toBe('/a&amp;b.png');
    });

    /**
     * 🔴 **Guard 2, and it is why a five-entity decoder is safe beside a complete one.**
     * parse5 knows every named reference and we know five. Where the two disagree our
     * offsets describe a string the browser never saw, so the attribute is refused
     * exactly as it was before any of this existed — the worst case is yesterday's
     * behaviour, never a wrong range.
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

  // `String.fromCharCode(10)` rather than an escape: this harness eats a backslash
  // in transit and turns `join('\n')` into a join on a literal newline. Third time
  // this session — the construction beats remembering.
  const NEWLINE = String.fromCharCode(10);

  describe('a <style> block built by a template (R25 #5)', () => {
    // `eleventy-docs/src/docs/data-js.md:133` holds `<style>` then
    // `{% if myProject.environment == "production" %}`. PostCSS dies on the `%`, and
    // before R20 that took the whole document's references with it. R20 masks
    // *unclosed* raw-text tags and deliberately leaves closed ones scanned, so this
    // is the gap that fix left — and Eleventy, Jekyll, Hugo, Nunjucks and Liquid all
    // inline conditional CSS exactly this way.

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
      // Rule 9: the block is declined, so it is declined out loud. The reason is the
      // same one the report already prints for a templated path.
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
   * Inline SVG — R26's second defect, and this adapter had the same hole as the JSX one.
   *
   * R26 reported it as a JSX gap. Measured, it was both: `<image href>` was missing from
   * this adapter's attribute map too. ARCHITECTURE.md recorded it as a known gap *"for
   * `.svg` files"*, and that framing is what hid it — an inline `<svg>` inside an HTML
   * document is not an `.svg` file, so no future SVG adapter would ever have reached it.
   *
   * Measured incidence across the three validation repos: **0**, which is why §5.1 could
   * not have found it.
   */
  describe('inline SVG — R26', () => {
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
     * ⚠️ A namespaced attribute needed a second fix, and it was a silent skip.
     *
     * parse5 splits `xlink:href` into `{ name: 'href', prefix: 'xlink' }` but keys its
     * source-location map by the **written** spelling, `'xlink:href'`. The adapter looked
     * the location up by the bare name, found nothing, and `continue`d — so even after
     * `<image>` was added to the map the attribute was still dropped, with no reason
     * recorded anywhere. That is the rule 9 shape, and it would have applied to any
     * namespaced attribute added later.
     */
    it('finds the location of a namespaced attribute, which is keyed by its spelling', () => {
      const source = '<svg><image xlink:href="/a/hero.png"/></svg>';
      const references = find(source);
      expect(references).toHaveLength(1);
      expect(source.slice(references[0]?.start, references[0]?.end)).toBe('/a/hero.png');
    });

    it('leaves a bare <image href> alone, because the parser makes it an <img>', () => {
      // Not a gap. Outside foreign content the HTML spec renames `<image>` to `<img>`,
      // and `href` is not an `<img>` attribute — so the markup genuinely displays nothing
      // and there is no reference to find.
      expect(find('<image href="/a/hero.png">')).toEqual([]);
    });

    it('leaves <use href> alone, deliberately', () => {
      // `<use href="#icon">` is a same-document element reference, not a file, and that is
      // the commonest form by far. Measured incidence of `<use>` naming an image across
      // the three validation repos: 0. Written down so adding it stays a decision.
      expect(find('<svg><use href="#icon"/></svg>')).toEqual([]);
      expect(find('<svg><use href="/a/sprite.svg#icon"/></svg>')).toEqual([]);
    });
  });

  /**
   * R26 — a space in a filename, on this adapter's side.
   *
   * These already worked before the fix, and the test exists to keep them working: the
   * defect was confined to the JavaScript adapter's speculative string rule, and three of
   * eighteen reference positions lost a spaced path. Asserting the fifteen that did not
   * is how a later "simplification" cannot quietly widen the hole.
   */
  describe('a space in a filename — R26', () => {
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
 * 🔴 **R98 — `<noscript>` CONTENT WAS RAW TEXT, AND THE WORD `noscript` APPEARED NOWHERE
 * IN THE ENGINE.** parse5 defaults `scriptingEnabled` to true, and with scripting enabled
 * the HTML spec says a `<noscript>` element's children are raw text: the parser returns one
 * text node and the `<img>` inside never becomes an element. Nothing was suppressing these
 * — they were never parsed.
 *
 * ⚠️ **It fails in the expensive direction.** `<noscript><img>` is the standard lazy-load
 * fallback, so `optimize --replace` rewrites every reference it can see, converts the
 * asset, and leaves the fallback naming a file that is gone — breaking precisely the render
 * that has no JavaScript to recover. Same severity class as R77.
 */
describe('R98 — an image inside <noscript> is markup, not text', () => {
  it('finds it', () => {
    const source = '<figure><noscript><img src="/img/hero.png"></noscript></figure>';

    expect(find(source).map((reference) => reference.rawPath)).toEqual(['/img/hero.png']);
  });

  it('keeps finding the ones around it — the control', () => {
    // A parser option is a blunt instrument. The case that would have caught a change
    // that fixed noscript and broke ordinary markup.
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

  it('🔴 does NOT yet read <template>, and that gap is pinned rather than silent', () => {
    // parse5 puts a template's children in a separate `content` fragment that `walk`
    // never descends into, so this is a DIFFERENT mechanism from noscript and is not
    // fixed by the parser option. Raised as a growth item with its shape id
    // (`html.template.content`) rather than fixed here. ⚠️ The assertion is deliberately
    // of today's WRONG behaviour: when somebody implements it this test goes red and
    // names itself, which is the opposite of the gap being discovered by accident.
    expect(find('<template><img src="/img/hero.png"></template>')).toEqual([]);
  });
});
