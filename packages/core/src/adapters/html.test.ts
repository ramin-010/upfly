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
    it('reports an entity-bearing path as unsafe instead of mislocating it', () => {
      // parse5 decodes `&amp;`, so the value is shorter than its source text and no
      // range would point at the path correctly. Rewriting on a mismatched range
      // would corrupt the document, so this is reported and left alone.
      const references = find('<img src="a&amp;b.png">');
      expect(references).toHaveLength(1);
      expect(references[0]?.ceiling).toBe('unsafe');
      expect(references[0]?.note).toMatch(/character references/);
    });

    it('leaves an ordinary path untouched by that rule', () => {
      expect(find('<img src="a-b.png">')[0]?.ceiling).toBe('high');
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
});
