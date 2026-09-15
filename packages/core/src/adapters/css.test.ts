import { describe, expect, it } from 'vitest';
import { UpflyError } from '../errors.js';
import type { RawReference } from '../types.js';
import { cssAdapter } from './css.js';
import { parseFailure } from './parse-failure.js';

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

    describe('R60: the message is ours and PostCSS is not quoted in it', () => {
      /** The `UpflyError` a dialect throws for a given source, or `null` if it parses. */
      function failure(source: string, file = '/project/a.css'): UpflyError | null {
        try {
          cssAdapter.findReferences({ file, text: source });
          return null;
        } catch (error) {
          return error instanceof UpflyError ? error : null;
        }
      }

      it.each([
        ['/project/a.css', 'css'],
        ['/project/a.scss', 'scss'],
        ['/project/a.less', 'less'],
      ])('%s: names the dialect we read it as and keeps the position', (file, dialect) => {
        // `railsgirls-com` carried 23 of these reading
        // `Could not parse: <css input>:144:13: Unknown word /`. `<css input>` is
        // PostCSS's placeholder for a file we did name, `Unknown word` is PostCSS's
        // vocabulary, and the position was the only part worth a reader's time.
        const error = failure('a { color: red; } }', file);

        expect(error?.message).toBe(
          `Could not parse: invalid ${dialect} syntax at line 1, column 19`,
        );
      });

      it('takes the position from the error, not from its message', () => {
        // The reason this survives a dependency upgrade. PostCSS is free to reword
        // `Unexpected }` or to stop prefixing `<css input>:1:19:` entirely; `line`
        // and `column` are structured fields and our sentence does not move.
        const error = failure(['a { color: red; }', '', 'b { c d e'].join('\n'));

        expect(error?.message).toBe('Could not parse: invalid css syntax at line 3, column 5');
      });

      it.each(['<css input>', 'Unexpected', 'Unknown word'])(
        'never puts %s in front of a user',
        (fragment) => {
          expect(failure('a { color: red; } }')?.message).not.toContain(fragment);
          expect(failure('a { b c d')?.message).not.toContain(fragment);
        },
      );

      it('keeps PostCSS-s own words on the diagnostic channel', () => {
        // Not lost, just not in a rule-11 artefact. Somebody debugging an adapter
        // wants exactly this string, and `scan` routes it to `onDiagnostic`.
        expect(failure('a { color: red; } }')?.diagnostic).toBe('<css input>:1:19: Unexpected }');
      });

      it('says so plainly when there is no position to report', () => {
        // Not every throw out of a parser is a syntax error with a location, and
        // inventing `line 0, column 0` would be a number that means nothing.
        expect(
          parseFailure({ error: new Error('something else'), dialect: 'css', position: 'postcss' })
            .message,
        ).toBe('Could not parse: the file is not valid css');
      });
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

/**
 * A quoted path parked in a preprocessor variable.
 *
 * 🔴 **THE ASSET IS NOT HEDGED, WHICH IS WHY THIS IS A DEFECT RATHER THAN A MISSING ROW.**
 * Without this, the only thing the engine sees is `url($hero)` — correctly `dynamic`, a
 * hedge that protects the REFERENCE and says nothing about the FILE. If `/img/hero.jpg` is
 * named nowhere else it looks dead, and `--replace` converts it and leaves the declaration
 * pointing at a name that is gone. Silently.
 *
 * ⚠️ **Two mechanisms, and only one of them is a declaration.** `$x: '…'` reaches
 * `walkDecls`; Less's `@x: '…'` is an AT-RULE to CSS's grammar and never does. A test that
 * only covered Sass would have passed against an engine that reads none of the Less half.
 */
describe('a path in a preprocessor variable declaration is a reference', () => {
  it.each([
    ['scss', '$hero: "/img/hero.jpg";\n', '/img/hero.jpg', 'styles.scss'],
    ['scss, single-quoted', "$hero: '/img/hero.jpg';\n", '/img/hero.jpg', 'styles.scss'],
    ['scss, relative', "$logo: '../assets/logo.png';\n", '../assets/logo.png', 'styles.scss'],
    ['less', '@hero: "/img/hero.jpg";\n', '/img/hero.jpg', 'styles.less'],
    ['less, single-quoted', "@hero: '/img/hero.jpg';\n", '/img/hero.jpg', 'styles.less'],
    // Odd spacing, because the Less offset is computed from `@` + name + `afterName` and
    // that arithmetic is exactly where an off-by-one lives.
    ['less, extra spacing', '@hero:    "/img/hero.jpg";\n', '/img/hero.jpg', 'styles.less'],
  ])('finds one in %s', (_name, source, expected, file) => {
    const references = cssAdapter.findReferences({ file: `/project/${file}`, text: source });

    expect(references.map((reference) => reference.rawPath)).toEqual([expected]);
    // The range invariant, checked by slicing rather than asserted.
    expect(slices(source, references)).toEqual([expected]);
  });

  it('marks it a GUESS, which is what keeps a wrong one out of the report', () => {
    const [reference] = cssAdapter.findReferences({
      file: '/project/styles.scss',
      text: "$hero: '/img/hero.jpg';\n",
    });

    // `asserted: false` is the difference between a hedge and a false positive: one that
    // hits nothing is `discarded`, where an asserted one would be reported `broken`.
    expect(reference).toMatchObject({ asserted: false, shape: 'scss.url' });
    expect(reference?.note).toContain('guessed rather than asserted');
  });

  /**
   * 🔴 **THE REJECTIONS ARE THE HALF THAT MATTERS.** A rule that collects every quoted
   * string in a variable would manufacture exactly the false positives R49 warns about,
   * and these are the strings it must refuse. **Measured on the validation corpus: of 16
   * quoted-string variable declarations across 194 real `.scss`/`.less` files, 0 have a
   * file extension — and every one of them is a media query, the first case below.**
   */
  it.each([
    ['a media query', '$big: "only screen and (min-width : 900px)";\n', 'styles.scss'],
    ['a directory with no extension', "$image-root: '/gallery';\n", 'styles.scss'],
    ['a less directory', '@image-root: "/gallery";\n', 'styles.less'],
    ['a selector list', '$extras: ".thumbnail-creator, .thumbnail-loves";\n', 'styles.scss'],
    ['an external url', "$cdn: 'https://cdn.example.com/x.png';\n", 'styles.scss'],
    // Prose that happens to name a file. The JS rule's SPACED_PATH anchoring is what
    // rejects this, and it is shared rather than reimplemented here.
    ['prose naming a file', "$note: 'see ./old.png for details';\n", 'styles.scss'],
    // Not a variable at all: in an ordinary declaration a quoted string is TEXT.
    ['content, which is a caption', '.a { content: "note.png"; }\n', 'styles.scss'],
    ['a plain CSS custom property', '.a { --brand: "/img/hero.jpg"; }\n', 'styles.css'],
  ])('refuses %s', (_name, source, file) => {
    expect(cssAdapter.findReferences({ file: `/project/${file}`, text: source })).toEqual([]);
  });

  it('does not disturb the url() that USES the variable', () => {
    // The use stays `dynamic` — nothing static to resolve, and nobody typed a wrong path.
    // Both are emitted, at two different positions, and that is the point: the
    // declaration names the file and the use names the variable.
    const source = "$hero: '/img/hero.jpg';\n.a { background: url($hero); }\n";
    const references = cssAdapter.findReferences({ file: '/project/s.scss', text: source });

    expect(references.map((reference) => [reference.shape, reference.rawPath])).toEqual([
      ['scss.url', '/img/hero.jpg'],
      ['scss.variable', '$hero'],
    ]);
  });

  it('does not claim a string inside a function, which url() and image-set already own', () => {
    // `!position.nested`: inside a function the string is an argument, and the two
    // functions that take a path are handled above this rule.
    const references = cssAdapter.findReferences({
      file: '/project/s.scss',
      text: "$shadow: some-fn('/img/hero.jpg');\n",
    });

    expect(references).toEqual([]);
  });
});

/**
 * 🔴 **R80(b) WAS RULED, THE CONDITION WAS WRITTEN AND SHARED AND TESTED, AND THE CSS
 * ADAPTER NEVER CALLED IT.** `assembledPathIsGlobbable` has governed the JavaScript
 * adapter's template literals since R89. A SCSS interpolation went straight to `unsafe`,
 * and `resolveOne` refuses an unsafe reference outright — so `resolved-pattern` was
 * reachable ONLY through a JS template literal. The rule was not missing; it was unwired.
 *
 * ⚠️ **This is an adapter test, so it asserts the CEILING rather than the resolution.**
 * The ceiling is the decision this file owns; whether the pattern names anything is
 * `matchPattern`'s question and is tested in `resolve.test.ts`.
 */
describe('R80(b) — a trailing interpolation is a pattern, not a dead end', () => {
  const ceilingOf = (source: string, file = '/project/s.scss') =>
    cssAdapter.findReferences({ file, text: source })[0]?.ceiling;

  it.each([
    ['a varying name', '.a { background: url("/theme-#{$mode}.png"); }'],
    [
      'a varying name with a suffix after it',
      '.a { background: url("/srcset/tile@#{$density}x.png"); }',
    ],
    ['a varying directory BELOW a fixed one', '.a { background: url("/img/#{$dir}/hero.png"); }'],
  ])('%s is medium, so the resolver globs it', (_name, source) => {
    expect(ceilingOf(source)).toBe('medium');
  });

  it.each([
    [
      'a leading interpolation, nothing fixed before it',
      '.a { background: url("#{$root}/photo.png"); }',
    ],
    ['two unknowns in one name', '.a { background: url("/icons/#{$theme}-#{$size}.png"); }'],
  ])('%s stays unsafe — globbing it would sweep in strangers', (_name, source) => {
    expect(ceilingOf(source)).toBe('unsafe');
  });

  it('applies to Less too, which has its own marker', () => {
    expect(ceilingOf('.a { background: url("/theme-@{mode}.png"); }', '/project/s.less')).toBe(
      'medium',
    );
  });

  /**
   * 🔴 **`#` MEANS TWO THINGS, AND THE FIRST VERSION OF THIS FIX GOT IT WRONG.** In CSS it
   * opens a URL fragment; in SCSS it opens an interpolation. `splitPathSuffix` knows only
   * the first, so `/theme-#{$mode}.png` came back as the path `/theme-` with `{$mode}.png`
   * discarded as a fragment — no image extension, dropped at rung 3, and the matrix moved
   * from `dynamic` to **`absent`**. A silent skip introduced by the fix for a silent skip,
   * and the matrix is what caught it within one run.
   */
  it('🔴 keeps the WHOLE path: a `#{` is an interpolation, not a fragment', () => {
    const source = '.a { background: url("/theme-#{$mode}.png"); }';
    const [reference] = cssAdapter.findReferences({ file: '/project/s.scss', text: source });

    expect(reference?.rawPath).toBe('/theme-#{$mode}.png');
    // The range invariant, checked by slicing rather than asserted.
    expect(source.slice(reference?.start, reference?.end)).toBe('/theme-#{$mode}.png');
  });

  it('still treats a real fragment as a fragment when there is no interpolation', () => {
    // The control. A fix that stopped splitting suffixes altogether would pass every
    // case above and break `url("/img/sprite.svg#icon")`.
    const [reference] = cssAdapter.findReferences({
      file: '/project/s.scss',
      text: '.a { background: url("/img/hero.png?v=2"); }',
    });

    expect(reference?.rawPath).toBe('/img/hero.png');
    expect(reference?.note).toContain('query or fragment preserved');
  });
});
