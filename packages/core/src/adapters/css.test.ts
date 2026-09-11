import { describe, expect, it } from 'vitest';
import type { RawReference } from '../types.js';
import { cssAdapter } from './css.js';

/**
 * Table-driven, per the adapter contract. Every case states the source and the
 * references expected from it; the helper checks the offsets by slicing them back
 * out of the source, which is the assertion that actually matters — an offset that
 * is off by one produces a rewrite landing in the wrong place.
 */

function find(text: string, file = '/project/styles.css'): RawReference[] {
  return cssAdapter.findReferences({ file, text });
}

/** What each reference points at, proven by slicing the source with its own range. */
function slices(text: string, references: readonly RawReference[]): string[] {
  return references.map((reference) => text.slice(reference.start, reference.end));
}

describe('cssAdapter', () => {
  it('claims the three dialects it can parse', () => {
    expect(cssAdapter.id).toBe('css');
    expect(cssAdapter.extensions).toEqual(['.css', '.scss', '.less']);
  });

  describe('finds url() references', () => {
    const cases: ReadonlyArray<[name: string, source: string, paths: readonly string[]]> = [
      ['unquoted', 'a { background: url(hero.png); }', ['hero.png']],
      ['double quoted', 'a { background: url("hero.png"); }', ['hero.png']],
      ['single quoted', "a { background: url('hero.png'); }", ['hero.png']],
      ['padded with spaces', 'a { background: url( hero.png ); }', ['hero.png']],
      ['uppercase function', 'a { background: URL(hero.png); }', ['hero.png']],
      ['relative path', 'a { background: url(../img/hero.png); }', ['../img/hero.png']],
      ['root relative', 'a { background: url(/img/hero.png); }', ['/img/hero.png']],
      ['a path containing spaces', 'a { background: url("my hero.png"); }', ['my hero.png']],
      ['inside a shorthand', 'a { background: url(a.png) no-repeat top; }', ['a.png']],
      [
        'nested in a gradient',
        'a { background: linear-gradient(red, blue), url(b.png); }',
        ['b.png'],
      ],
      ['in a custom property', 'a { --bg: url(c.png); }', ['c.png']],
      ['in @font-face', '@font-face { src: url(f.png); }', ['f.png']],
      ['inside @media', '@media (min-width: 1px) { a { background: url(m.png); } }', ['m.png']],
      [
        'several in one declaration',
        'a { background: url(one.png), url("two.png"); }',
        ['one.png', 'two.png'],
      ],
      [
        'several declarations',
        'a { background: url(one.png); }\nb { border-image: url(two.png); }',
        ['one.png', 'two.png'],
      ],
    ];

    it.each(cases)('%s', (_name, source, paths) => {
      const references = find(source);
      expect(references.map((reference) => reference.rawPath)).toEqual([...paths]);
      // The offsets must select exactly the path text, quotes excluded.
      expect(slices(source, references)).toEqual([...paths]);
      for (const reference of references) {
        expect(reference.kind).toBe('css-url');
        expect(reference.asserted).toBe(true);
      }
    });
  });

  describe('finds image-set() references', () => {
    const cases: ReadonlyArray<[name: string, source: string, paths: readonly string[]]> = [
      [
        'bare strings are paths',
        'a { background-image: image-set("a.png" 1x, "b.png" 2x); }',
        ['a.png', 'b.png'],
      ],
      [
        'vendor prefixed',
        'a { background-image: -webkit-image-set(url(a.png) 1x, url(b.png) 2x); }',
        ['a.png', 'b.png'],
      ],
      [
        'mixed url() and bare string',
        'a { background-image: image-set(url(a.png) 1x, "b.png" 2x); }',
        ['a.png', 'b.png'],
      ],
    ];

    it.each(cases)('%s', (_name, source, paths) => {
      const references = find(source);
      expect(references.map((reference) => reference.rawPath)).toEqual([...paths]);
      expect(slices(source, references)).toEqual([...paths]);
    });

    it('does not treat a bare string in an ordinary function as a path', () => {
      // `format("woff2")` is a font format name, not a file.
      expect(find('@font-face { src: url(f.png) format("woff2"); }')).toHaveLength(1);
    });
  });

  describe('ignores things that are not local files', () => {
    const cases: ReadonlyArray<[name: string, source: string]> = [
      ['data URIs', 'a { background: url(data:image/png;base64,AAAA); }'],
      ['https URLs', 'a { background: url(https://cdn.example.com/x.png); }'],
      ['http URLs', 'a { background: url("http://cdn.example.com/x.png"); }'],
      ['protocol-relative URLs', 'a { background: url(//cdn.example.com/x.png); }'],
      ['SVG fragment references', 'a { fill: url(#gradient); }'],
      ['an empty url()', 'a { background: url(); }'],
      ['a bare query string', 'a { background: url(?v=2); }'],
    ];

    it.each(cases)('%s', (_name, source) => {
      expect(find(source)).toEqual([]);
    });
  });

  describe('never mistakes commented-out code for a reference', () => {
    it('ignores a whole-line comment', () => {
      expect(find('/* a { background: url(old.png); } */\na { color: red; }')).toEqual([]);
    });

    it('ignores a comment inside a declaration value, and keeps the real one', () => {
      const source = 'a { background: url(real.png) /* url(fake.png) */ no-repeat; }';
      const references = find(source);
      expect(references.map((reference) => reference.rawPath)).toEqual(['real.png']);
      expect(slices(source, references)).toEqual(['real.png']);
    });

    it('ignores a comment sitting between the property and the value', () => {
      const source = "a { background: /* note */ url('real.png'); }";
      const references = find(source);
      expect(references.map((reference) => reference.rawPath)).toEqual(['real.png']);
      // This is the case that catches offset arithmetic missing `raws.between`.
      expect(slices(source, references)).toEqual(['real.png']);
    });

    it('ignores a // line comment in SCSS', () => {
      const source = 'a {\n  // url(old.png)\n  background: url(new.png);\n}';
      const references = find(source, '/project/theme.scss');
      expect(references.map((reference) => reference.rawPath)).toEqual(['new.png']);
      expect(slices(source, references)).toEqual(['new.png']);
    });

    it('ignores a // line comment in Less', () => {
      const source = '.a {\n  background: url(new.png); // url(old.png)\n}';
      const references = find(source, '/project/legacy.less');
      expect(references.map((reference) => reference.rawPath)).toEqual(['new.png']);
      expect(slices(source, references)).toEqual(['new.png']);
    });
  });

  describe('reports dynamic paths as unsafe rather than guessing', () => {
    const cases: ReadonlyArray<[name: string, source: string, file: string, note: RegExp]> = [
      [
        'SCSS interpolation',
        'a { background: url("#{$dir}/hero.png"); }',
        '/project/theme.scss',
        /SCSS interpolation/,
      ],
      ['SCSS variable', 'a { background: url($hero); }', '/project/theme.scss', /SCSS variable/],
      [
        'Less interpolation',
        '.a { background: url("@{dir}/hero.png"); }',
        '/project/legacy.less',
        /Less interpolation/,
      ],
      [
        'a CSS variable',
        'a { background: url(var(--hero)); }',
        '/project/styles.css',
        /function call/,
      ],
    ];

    it.each(cases)('%s', (_name, source, file, note) => {
      const references = find(source, file);
      expect(references).toHaveLength(1);
      const [reference] = references;
      expect(reference?.ceiling).toBe('unsafe');
      expect(reference?.note).toMatch(note);
      // Still reported: a silent skip is a P0 bug.
      expect(reference?.asserted).toBe(true);
    });
  });

  describe('query strings and fragments', () => {
    it('reports the path alone so a rewrite preserves the suffix', () => {
      const source = 'a { background: url(hero.png?v=2); }';
      const references = find(source);
      expect(references[0]?.rawPath).toBe('hero.png');
      expect(slices(source, references)).toEqual(['hero.png']);
      expect(references[0]?.note).toMatch(/\?v=2/);
    });

    it('handles a fragment suffix the same way', () => {
      const source = 'a { background: url("hero.png#part"); }';
      const references = find(source);
      expect(references[0]?.rawPath).toBe('hero.png');
      expect(slices(source, references)).toEqual(['hero.png']);
    });

    it('rewriting swaps the path and leaves the query in place', () => {
      const source = 'a { background: url(hero.png?v=2); }';
      const [reference] = find(source);
      const rewritten = cssAdapter.rewrite({
        text: source,
        edits: [
          {
            start: reference?.start ?? 0,
            end: reference?.end ?? 0,
            replacement: 'hero.webp',
          },
        ],
      });
      expect(rewritten).toBe('a { background: url(hero.webp?v=2); }');
    });
  });

  describe('offsets are UTF-16 code units', () => {
    it('stays aligned after an emoji earlier in the file', () => {
      // An emoji is two UTF-16 code units and four UTF-8 bytes. If offsets were
      // byte-based, every reference after this point would land two positions off.
      const source = 'a { content: "🎉"; background: url(hero.png); }';
      const references = find(source);
      expect(slices(source, references)).toEqual(['hero.png']);
    });

    it('handles a non-ASCII path', () => {
      const source = 'a { background: url("héro-café.png"); }';
      const references = find(source);
      expect(references[0]?.rawPath).toBe('héro-café.png');
      expect(slices(source, references)).toEqual(['héro-café.png']);
    });
  });

  describe('rewrite', () => {
    it('replaces a path in place', () => {
      const source = 'a { background: url(hero.png) no-repeat; }';
      const [reference] = find(source);
      const rewritten = cssAdapter.rewrite({
        text: source,
        edits: [
          { start: reference?.start ?? 0, end: reference?.end ?? 0, replacement: 'hero.webp' },
        ],
      });
      expect(rewritten).toBe('a { background: url(hero.webp) no-repeat; }');
    });

    it('replaces several paths in one pass', () => {
      const source = 'a { background: url(one.png), url("two.png"); }';
      const references = find(source);
      const rewritten = cssAdapter.rewrite({
        text: source,
        edits: references.map((reference) => ({
          start: reference.start,
          end: reference.end,
          replacement: reference.rawPath.replace('.png', '.webp'),
        })),
      });
      expect(rewritten).toBe('a { background: url(one.webp), url("two.webp"); }');
    });

    it('is a no-op with no edits', () => {
      const source = 'a { background: url(hero.png); }';
      expect(cssAdapter.rewrite({ text: source, edits: [] })).toBe(source);
    });
  });

  describe('is pure', () => {
    it('returns the same result for the same input', () => {
      const source = 'a { background: url(one.png), image-set("two.png" 2x); }';
      expect(find(source)).toEqual(find(source));
    });

    it('does not depend on the file path beyond choosing a parser', () => {
      const source = 'a { background: url(hero.png); }';
      expect(find(source, '/one/a.css')[0]?.start).toBe(find(source, '/two/b.css')[0]?.start);
    });

    it('records the file it was given on every reference', () => {
      const references = find('a { background: url(hero.png); }', '/project/src/theme.css');
      expect(references[0]?.file).toBe('/project/src/theme.css');
    });
  });

  describe('failure is loud', () => {
    it('rejects an extension it does not handle', () => {
      expect(() => find('body {}', '/project/styles.sass')).toThrow(
        expect.objectContaining({ code: 'ADAPTER_PARSE_FAILED' }),
      );
    });

    it('rejects a file with no extension', () => {
      expect(() => find('body {}', '/project/styles')).toThrow(
        expect.objectContaining({ code: 'ADAPTER_PARSE_FAILED' }),
      );
    });

    it('reports a parse error rather than claiming the file has no references', () => {
      // Returning [] here would be a silent skip, and the file would look clean.
      expect(() => find('a { background: url(hero.png);')).toThrow(
        expect.objectContaining({ code: 'ADAPTER_PARSE_FAILED' }),
      );
    });
  });

  it('returns references sorted by position', () => {
    const source = [
      'c { background: url(third.png); }',
      'a { background: url(first.png); }',
      'b { background: url(second.png); }',
    ].join('\n');
    const references = find(source);
    expect(references.map((reference) => reference.rawPath)).toEqual([
      'third.png',
      'first.png',
      'second.png',
    ]);
    const starts = references.map((reference) => reference.start);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });
});

describe('a parenthesis inside quotes is a character, not a function call (R26 class)', () => {
  // Found by `scratch-www` in B1's re-validation: four assets reported `dead` —
  // *safe to delete* — about files the live site serves, because
  // `url("/images/quote (blue).svg")` was read as containing a function call. The
  // reference became `dynamic`, linked nothing, and the asset looked unreferenced.
  const find = (text: string) => cssAdapter.findReferences({ file: '/project/a.scss', text });

  it('treats a quoted path with parentheses as a literal path', () => {
    const [reference] = find('a { background-image: url("/images/quote (blue).svg"); }');

    expect(reference?.rawPath).toBe('/images/quote (blue).svg');
    expect(reference?.ceiling).toBe('high');
    expect(reference?.note).toBeUndefined();
  });

  it('treats a quoted path with parentheses AND spaces as a literal path', () => {
    const [reference] = find(
      'a { background-image: url("/img/3_Community/Timeline Background (Base).svg"); }',
    );

    expect(reference?.rawPath).toBe('/img/3_Community/Timeline Background (Base).svg');
    expect(reference?.ceiling).toBe('high');
  });

  it('still refuses an UNQUOTED function call — the control', () => {
    // The assertion above would pass with the check deleted outright. This is what
    // stops that: a real SCSS function call must stay `unsafe`.
    const [reference] = find('a { background-image: url(map-get($images, hero)); }');

    expect(reference?.ceiling).toBe('unsafe');
    expect(reference?.note).toContain('function call');
  });

  it.each([
    ['SCSS interpolation', 'url("#{$path}/hero.png")'],
    ['Less interpolation', 'url("@{path}/hero.png")'],
    ['a CSS-in-JS substitution hole', 'url("/*------*/")'],
  ])('keeps %s unsafe even inside quotes', (_name, value) => {
    // The other markers are NOT quote-sensitive, and that asymmetry is the whole
    // design: interpolation and the comment the JS adapter substitutes appear inside
    // quotes routinely, while a function call cannot.
    const [reference] = find(`a { background-image: ${value}; }`);

    expect(reference?.ceiling).toBe('unsafe');
  });
});
