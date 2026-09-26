import { describe, expect, it } from 'vitest';
import { UpflyError } from '../errors.js';
import type { RawReference } from '../types.js';
import { javaScriptParseOutcome, javascriptAdapter } from './javascript.js';

/**
 * Table-driven, as the adapter rules require. The group that matters most is "never
 * mistakes text for code". See "Adapters: the contribution surface" in ARCHITECTURE.md.
 */

function find(text: string, file = '/project/src/App.jsx'): RawReference[] {
  return javascriptAdapter.findReferences({ file, text });
}

function paths(text: string, file?: string): string[] {
  return find(text, file).map((reference) => reference.rawPath);
}

function slices(text: string, file?: string): string[] {
  return find(text, file).map((reference) => text.slice(reference.start, reference.end));
}

describe('javascriptAdapter', () => {
  it('claims the javascript and typescript extensions', () => {
    expect(javascriptAdapter.id).toBe('javascript');
    expect(javascriptAdapter.extensions).toEqual([
      '.js',
      '.jsx',
      '.mjs',
      '.cjs',
      '.ts',
      '.tsx',
      '.mts',
      '.cts',
    ]);
  });

  describe('module references', () => {
    const cases: ReadonlyArray<[name: string, source: string, expected: readonly string[]]> = [
      ['default import', "import logo from './logo.png';", ['./logo.png']],
      ['side-effect import', "import './styles.css';", ['./styles.css']],
      ['named import', "import { a } from './mod';", ['./mod']],
      ['double-quoted', 'import logo from "./logo.png";', ['./logo.png']],
      ['require', "const logo = require('./logo.png');", ['./logo.png']],
      ['dynamic import', "const p = import('./logo.png');", ['./logo.png']],
      ['await import', "const p = await import('./logo.png');", ['./logo.png']],
      ['new URL', "const u = new URL('./img.png', import.meta.url);", ['./img.png']],
      [
        'several in one file',
        "import a from './a.png';\nimport b from './b.png';",
        ['./a.png', './b.png'],
      ],
    ];

    it.each(cases)('%s', (_name, source, expected) => {
      expect(paths(source)).toEqual([...expected]);
      expect(slices(source)).toEqual([...expected]);
    });

    it('marks a static import as certain', () => {
      expect(find("import logo from './logo.png';")[0]?.ceiling).toBe('certain');
    });

    it('marks new URL as high rather than certain', () => {
      expect(find("new URL('./img.png', import.meta.url);")[0]?.ceiling).toBe('high');
    });

    it('treats new URL without import.meta.url as a guess, not an assertion', () => {
      // Not a bundled asset, so not `certain`, but a runtime URL still 404s if the file it
      // names is converted and this line is not updated. As a guess it links when the path
      // resolves and is discarded when it does not, so it never becomes a false `broken`.
      const [reference] = find("const u = new URL('./img.png');");

      expect(reference?.rawPath).toBe('./img.png');
      expect(reference?.asserted).toBe(false);
    });

    it('treats a require-like call as a guess, not an assertion', () => {
      const [reference] = find("myRequire('./logo.png');");

      expect(reference?.rawPath).toBe('./logo.png');
      expect(reference?.asserted).toBe(false);
    });

    it('emits bare specifiers, which the resolver drops by extension', () => {
      // The adapter does not filter by extension: that policy lives in one place, the
      // resolver.
      expect(paths("import React from 'react';")).toEqual(['react']);
    });
  });

  describe('Node subpath imports', () => {
    it('keeps a #-prefixed import instead of dropping it as a fragment', () => {
      // A leading `#` is a document fragment nearly everywhere, but in a module specifier
      // it is a Node subpath import. Dropped, it would vanish from every report with no
      // reason given, which is a silent skip.
      expect(paths("import logo from '#assets/logo.png';")).toEqual(['#assets/logo.png']);
    });

    it('keeps it for require and dynamic import too', () => {
      expect(paths("const a = require('#assets/a.png');")).toEqual(['#assets/a.png']);
      expect(paths("const b = import('#assets/b.png');")).toEqual(['#assets/b.png']);
    });

    it('still drops a fragment in a JSX attribute, which is not a specifier', () => {
      // Keyed on `kind`, not on which adapter emitted it: the same adapter produces
      // both, and only `kind === 'import'` marks a module-specifier position.
      expect(paths('<img src="#anchor" />')).toEqual([]);
    });

    it('still drops a fragment in CSS-in-JS', () => {
      expect(paths('const H = styled.div`fill: url(#gradient);`;')).toEqual([]);
    });
  });

  describe('TypeScript', () => {
    it('reads a .ts file', () => {
      const source = "import logo from './logo.png';\nconst x: string = logo;";
      expect(paths(source, '/project/src/app.ts')).toEqual(['./logo.png']);
    });

    it('skips a type-only import, which is erased at compile time', () => {
      const source = "import type { Logo } from './logo';\nimport logo from './logo.png';";
      expect(paths(source, '/project/src/app.ts')).toEqual(['./logo.png']);
    });

    it('parses an angle-bracket type assertion in .ts', () => {
      // In a .ts file this is a cast; in .tsx it would open a JSX element. Enabling
      // the jsx plugin everywhere would make this valid TypeScript unparseable.
      const source = "const a = <string>b;\nimport logo from './logo.png';";
      expect(paths(source, '/project/src/app.ts')).toEqual(['./logo.png']);
    });

    it('parses JSX in .tsx', () => {
      const source = 'export const A = () => <img src="/hero.png" />;';
      expect(paths(source, '/project/src/App.tsx')).toEqual(['/hero.png']);
    });

    it('parses satisfies and decorators', () => {
      const source = [
        '@Component({})',
        'class A {}',
        'const c = { x: 1 } satisfies Record<string, number>;',
        "import logo from './logo.png';",
      ].join('\n');
      expect(paths(source, '/project/src/app.ts')).toEqual(['./logo.png']);
    });
  });

  describe('JSX attributes', () => {
    const cases: ReadonlyArray<[name: string, source: string, expected: readonly string[]]> = [
      ['src string', '<img src="/hero.png" />', ['/hero.png']],
      ['srcSet string', '<img srcSet="/a.png 1x" />', ['/a.png']],
      ['poster', '<video poster="/p.png" />', ['/p.png']],
      ['src in an expression container', '<img src={"/hero.png"} />', ['/hero.png']],
      [
        'ignores alt and title',
        '<img alt="/not.png" title="/no.png" src="/yes.png" />',
        ['/yes.png'],
      ],
      ['ignores an identifier value', '<img src={logo} />', []],
      ['ignores a call expression value', '<img src={getSrc()} />', []],
      ['ignores a conditional value', '<img src={a ? b : c} />', []],
    ];

    it.each(cases)('%s', (_name, source, expected) => {
      expect(paths(source)).toEqual([...expected]);
    });

    it('splits srcSet into candidates, as the HTML adapter does', () => {
      // Left unsplit this is two false positives: the whole string resolves to
      // nothing, and every image but the first gains no reference and looks dead.
      const source = '<img srcSet="/a.png 1x, /b.png 2x" />';
      expect(paths(source)).toEqual(['/a.png', '/b.png']);
      expect(slices(source)).toEqual(['/a.png', '/b.png']);
    });

    it('rewrites one srcSet candidate without disturbing the others', () => {
      const source = '<img srcSet="/a.png 1x, /b.png 2x" />';
      const second = find(source)[1];
      const rewritten = javascriptAdapter.rewrite({
        text: source,
        edits: [{ start: second?.start ?? 0, end: second?.end ?? 0, replacement: '/b.webp' }],
      });
      expect(rewritten).toBe('<img srcSet="/a.png 1x, /b.webp 2x" />');
    });

    it('marks a JSX string attribute as high', () => {
      expect(find('<img src="/hero.png" />')[0]?.ceiling).toBe('high');
    });

    it('finds the import and the JSX attribute independently', () => {
      const source = [
        'import logo from "./logo.png";',
        'export const A = () => <img src={logo} />;',
      ].join('\n');
      expect(paths(source)).toEqual(['./logo.png']);
    });
  });

  describe('template literals', () => {
    it('treats a template with no expressions as a plain path', () => {
      const source = 'const p = import(`./logo.png`);';
      expect(paths(source)).toEqual(['./logo.png']);
      expect(slices(source)).toEqual(['./logo.png']);
      expect(find(source)[0]?.ceiling).toBe('high');
    });

    it('marks a template with expressions as medium, never broken', () => {
      const source = 'const p = import(`./images/${name}.png`);';
      const references = find(source);
      expect(references).toHaveLength(1);
      expect(references[0]?.ceiling).toBe('medium');
      expect(references[0]?.rawPath).toBe('./images/${name}.png');
      expect(slices(source)).toEqual(['./images/${name}.png']);
    });

    it('handles a JSX template attribute', () => {
      const source = '<img src={`/images/${slug}.png`} />';
      const references = find(source);
      expect(references[0]?.ceiling).toBe('medium');
      expect(slices(source)).toEqual(['/images/${slug}.png']);
    });

    it('keeps offsets exact across several expressions', () => {
      const source = 'const p = import(`/${a}/${b}/hero.png`);';
      expect(slices(source)).toEqual(['/${a}/${b}/hero.png']);
    });
  });

  describe('CSS-in-JS', () => {
    const cases: ReadonlyArray<[name: string, source: string, expected: readonly string[]]> = [
      ['styled.div', 'const H = styled.div`background: url(/a.png);`;', ['/a.png']],
      ['styled(Component)', 'const H = styled(Box)`background: url(/a.png);`;', ['/a.png']],
      ['styled.div.attrs', 'const H = styled.div.attrs({})`background: url(/a.png);`;', ['/a.png']],
      ['css helper', 'const c = css`background: url(/a.png);`;', ['/a.png']],
      [
        'createGlobalStyle',
        'const g = createGlobalStyle`body{background:url(/a.png)}`;',
        ['/a.png'],
      ],
      ['not a css tag', 'const q = sql`select url(/a.png)`;', []],
    ];

    it.each(cases)('%s', (_name, source, expected) => {
      expect(paths(source)).toEqual([...expected]);
      expect(slices(source)).toEqual([...expected]);
    });

    it('keeps offsets correct when an interpolation precedes the url', () => {
      const source = 'const H = styled.div`\n  color: ${theme.fg};\n  background: url(/a.png);\n`;';
      expect(paths(source)).toEqual(['/a.png']);
      expect(slices(source)).toEqual(['/a.png']);
    });

    it('reports a url built from an interpolation as unsafe', () => {
      const source = 'const H = styled.div`background: url(${bg});`;';
      const references = find(source);
      expect(references).toHaveLength(1);
      expect(references[0]?.ceiling).toBe('unsafe');
    });

    it('supports nesting, which plain CSS would reject', () => {
      const source = 'const H = styled.div`\n  &:hover { background: url(/a.png); }\n`;';
      expect(paths(source)).toEqual(['/a.png']);
    });

    it('ignores a url inside a CSS comment in a template', () => {
      const source = 'const H = styled.div`/* url(/fake.png) */ background: url(/real.png);`;';
      expect(paths(source)).toEqual(['/real.png']);
    });
  });

  describe('never mistakes text for code', () => {
    // This is the group that justifies using a parser. A regex finds a path in
    // every one of these; the rewrite stage would then edit the wrong bytes.
    const cases: ReadonlyArray<[name: string, source: string]> = [
      ['a line comment', "// import logo from './old.png';"],
      ['a block comment', "/*\nimport logo from './old.png';\n*/"],
      ['a JSDoc example', "/** @example import logo from './old.png' */"],
      ['a string that looks like an import', `const s = "import logo from './old.png'";`],
      ['a path inside unrelated data', `const meta = { note: "see ./old.png for details" };`],
      ['a commented-out require', "// const x = require('./old.png');"],
      ['a path in a template used as prose', 'const msg = `we removed ./old.png last week`;'],
    ];

    it.each(cases)('ignores %s', (_name, source) => {
      expect(find(source)).toEqual([]);
    });

    it('finds the real reference alongside a decoy comment', () => {
      const source = ["// import old from './old.png';", "import fresh from './fresh.png';"].join(
        '\n',
      );
      expect(paths(source)).toEqual(['./fresh.png']);
      expect(slices(source)).toEqual(['./fresh.png']);
    });
  });

  describe('ignores things that are not local files', () => {
    const cases: ReadonlyArray<[name: string, source: string]> = [
      ['https URLs', `const u = new URL('https://cdn.example.com/x.png', import.meta.url);`],
      ['data URIs', '<img src="data:image/png;base64,AAAA" />'],
      ['protocol-relative URLs', '<img src="//cdn.example.com/x.png" />'],
      ['empty strings', "import '';"],
    ];

    it.each(cases)('%s', (_name, source) => {
      expect(find(source)).toEqual([]);
    });
  });

  describe('escape sequences', () => {
    it('reports a string with escapes as unsafe rather than mislocating it', () => {
      // `\u002D` is an escaped hyphen: Babel decodes it, so the value is 9 characters
      // where the source text is 14. No range points at the path, and a rewrite computed
      // from a mismatched range would corrupt the file.
      const source = String.raw`import logo from './a\u002Db.png';`;
      const references = find(source);
      expect(references).toHaveLength(1);
      expect(references[0]?.ceiling).toBe('unsafe');
      expect(references[0]?.note).toMatch(/escape sequences/);
    });

    it('leaves an ordinary path alone', () => {
      expect(find("import logo from './a-b.png';")[0]?.ceiling).toBe('certain');
    });
  });

  describe('query suffixes', () => {
    it('keeps a Vite import suffix outside the range', () => {
      const source = "import raw from './logo.png?raw';";
      expect(paths(source)).toEqual(['./logo.png']);
      expect(slices(source)).toEqual(['./logo.png']);
      expect(find(source)[0]?.note).toMatch(/\?raw/);
    });

    it('rewrites the path and preserves the suffix', () => {
      const source = "import raw from './logo.png?raw';";
      const rewritten = javascriptAdapter.rewrite({
        text: source,
        edits: find(source).map((reference) => ({
          start: reference.start,
          end: reference.end,
          replacement: './logo.webp',
        })),
      });
      expect(rewritten).toBe("import raw from './logo.webp?raw';");
    });
  });

  describe('offsets are UTF-16 code units', () => {
    it('stays aligned after an emoji earlier in the file', () => {
      const source = "const party = '🎉';\nimport logo from './logo.png';";
      expect(slices(source)).toEqual(['./logo.png']);
    });

    it('handles a non-ASCII path', () => {
      const source = "import logo from './héro-café.png';";
      expect(paths(source)).toEqual(['./héro-café.png']);
      expect(slices(source)).toEqual(['./héro-café.png']);
    });
  });

  describe('failure is loud', () => {
    it('rejects an extension it does not handle', () => {
      expect(() => find('x', '/project/a.vue')).toThrow(
        expect.objectContaining({ code: 'ADAPTER_PARSE_FAILED' }),
      );
    });

    it('reports a syntax error rather than claiming the file is clean', () => {
      expect(() => find('const = = ;')).toThrow(
        expect.objectContaining({ code: 'ADAPTER_PARSE_FAILED' }),
      );
    });

    describe('the message is ours and Babel is not quoted in it', () => {
      /** The `UpflyError` this source throws, or `null` if it parses. */
      function failure(source: string, file = '/project/a.js'): UpflyError | null {
        try {
          javascriptAdapter.findReferences({ file, text: source });
          return null;
        } catch (error) {
          return error instanceof UpflyError ? error : null;
        }
      }

      it('counts the column from one, where Babel counts it from zero', () => {
        // PostCSS puts a 1-based `line` and `column` on its error, and Babel puts
        // `loc: { line, column }` with a 0-based column, which is why `parseFailure` is told
        // which parser ran. Read the PostCSS way, every JavaScript failure would be reported
        // one column to the left, a wrong number that looks right.
        //
        // Babel says `Unexpected token (1:6)` for this source; an editor calls it column 7.
        const error = failure('const = ;');

        expect(error?.diagnostic).toBe('Unexpected token (1:6)');
        expect(error?.message).toBe(
          'Could not parse: invalid JavaScript syntax at line 1, column 7',
        );
      });

      it.each(['a.js', 'a.jsx', 'a.ts', 'a.tsx', 'a.mjs', 'a.cjs'])(
        '%s: says the same thing whichever dialect the extension claims',
        (name) => {
          // The extension picks Babel's plugin set, not our wording: a syntax error in
          // TSX is still a JavaScript file we could not read, and inventing six
          // spellings of that would be six strings to keep in step for no reader's
          // benefit.
          expect(failure('function (', `/project/${name}`)?.message).toBe(
            'Could not parse: invalid JavaScript syntax at line 1, column 10',
          );
        },
      );

      it.each(['Unexpected token', '(1:6)'])('never puts %s in front of a user', (fragment) => {
        expect(failure('const = ;')?.message).not.toContain(fragment);
      });

      it('still prefers our own sentence when the file is not JavaScript at all', () => {
        // The template sentence comes first. A Nunjucks template is not broken JavaScript,
        // and `invalid JavaScript syntax at line 1, column 2` would be precise and useless,
        // a position in the wrong language. Babel's text still reaches the diagnostic.
        const error = failure('{% for x in y %}<img src="/a.png">{% endfor %}');

        expect(error?.message).toBe(
          'Could not parse: this looks like Nunjucks, Jinja or Liquid template source rather than JavaScript — it begins with `{%`',
        );
        expect(error?.diagnostic).toBe('Unexpected token (1:1)');
      });
    });
  });

  describe('is pure and deterministic', () => {
    it('returns the same result for the same input', () => {
      const source = "import a from './a.png';\nconst H = styled.div`background:url(/b.png)`;";
      expect(find(source)).toEqual(find(source));
    });

    it('returns references sorted by position', () => {
      const source = [
        'const H = styled.div`background:url(/second.png)`;',
        "import third from './third.png';",
      ].join('\n');
      const starts = find(source).map((reference) => reference.start);
      expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    });

    it('records the file it was given', () => {
      expect(find("import a from './a.png';", '/project/src/x.jsx')[0]?.file).toBe(
        '/project/src/x.jsx',
      );
    });
  });

  describe('CSS-in-JS interpolation placeholders', () => {
    it('keeps a real url when a mixin is interpolated at statement level', () => {
      // The common styled-components shape. Standing an interpolation in for
      // `${baseStyles}` here fails to parse and would cost us the url below it,
      // which is why the placeholder is a comment rather than an interpolation.
      const source = [
        'const H = styled.div`',
        '  ${baseStyles}',
        '  background: url(/hero.png);',
        '`;',
      ].join('\n');
      expect(paths(source)).toEqual(['/hero.png']);
      expect(slices(source)).toEqual(['/hero.png']);
    });

    it('keeps a real url when an interpolation appears in a selector', () => {
      const source = 'const H = styled.div`&.${active} { background: url(/a.png); }`;';
      expect(paths(source)).toEqual(['/a.png']);
      expect(slices(source)).toEqual(['/a.png']);
    });

    it('still reports an interpolated url itself as unsafe', () => {
      const source = 'const H = styled.div`${base} background: url(${bg});`;';
      const references = find(source);
      expect(references).toHaveLength(1);
      expect(references[0]?.ceiling).toBe('unsafe');
    });

    it('reports a template that is not parseable as CSS instead of dropping it', () => {
      const source = 'const H = styled.div`}`;';
      const references = find(source);
      expect(references).toHaveLength(1);
      expect(references[0]?.ceiling).toBe('unsafe');
      expect(references[0]?.note).toMatch(/could not be parsed as CSS/);
    });

    it('ignores a tagged template whose tag is not a named function', () => {
      expect(paths('const H = (a || b)`background: url(/a.png);`;')).toEqual([]);
    });
  });

  describe('values that are not literal paths', () => {
    it('ignores a namespaced JSX attribute', () => {
      expect(paths('<img ns:src="/a.png" />')).toEqual([]);
    });

    it('ignores a valueless JSX attribute', () => {
      expect(paths('<img src />')).toEqual([]);
    });

    it('ignores require with a non-literal argument', () => {
      expect(paths('const a = require(name);')).toEqual([]);
    });

    it('ignores require with no arguments', () => {
      expect(paths('const a = require();')).toEqual([]);
    });

    it('ignores new URL with a non-literal first argument', () => {
      expect(paths('const u = new URL(name, import.meta.url);')).toEqual([]);
    });

    it('does not assert a new URL whose second argument is not import.meta.url', () => {
      const [reference] = find("const u = new URL('./a.png', base);");

      expect(reference?.asserted).toBe(false);
    });
  });

  describe('rewrite', () => {
    it('replaces paths across imports, JSX and CSS-in-JS in one pass', () => {
      const source = [
        "import logo from './logo.png';",
        'const H = styled.div`background: url(/bg.png);`;',
        'export const A = () => <img src="/hero.png" />;',
      ].join('\n');
      const rewritten = javascriptAdapter.rewrite({
        text: source,
        edits: find(source).map((reference) => ({
          start: reference.start,
          end: reference.end,
          replacement: reference.rawPath.replace('.png', '.webp'),
        })),
      });
      expect(rewritten).toBe(
        [
          "import logo from './logo.webp';",
          'const H = styled.div`background: url(/bg.webp);`;',
          'export const A = () => <img src="/hero.webp" />;',
        ].join('\n'),
      );
    });

    it('is a no-op with no edits', () => {
      const source = "import a from './a.png';";
      expect(javascriptAdapter.rewrite({ text: source, edits: [] })).toBe(source);
    });
  });

  describe('templated URLs are external too', () => {
    /**
     * The external-URL test runs even when `skipPathChecks` is set: that flag means only
     * that suffix splitting would be wrong on the text. A templated URL names another
     * server's file whatever its holes hold, so it is dropped rather than reported.
     */

    it.each([
      ['https://${branch}.previews.example.com/', 'an interpolated host'],
      ['https://raw.githubusercontent.com/${repo}/${ref}/pkg', 'an interpolated path'],
      ['//${cdn}/hero.png', 'protocol-relative'],
    ])('drops %s (%s)', (url) => {
      const references = find(`const target = \`${url}\`;`);

      expect(references).toEqual([]);
    });

    it('still keeps a template whose static prefix is a real path', () => {
      // The control: a hole at the start is not a scheme, so this is kept as a local path
      // rather than dropped as a URL.
      const references = find('const src = `${base}/img/hero.png`;');

      expect(references).toHaveLength(1);
    });

    it('but does not glob it, because the directory is the unknown part', () => {
      // A pattern needs a fixed directory, so this is refused rather than globbed, and its
      // note says why: every declined item reaches the report with a reason.
      const [reference] = find('const src = `${base}/img/hero.png`;');

      expect(reference?.ceiling).toBe('unsafe');
      expect(reference?.note).toContain('a pattern needs a fixed directory');
    });

    it('keeps a relative templated path whose hole is the whole filename stem', () => {
      // The shape test reads each hole as `*`. With the holes deleted instead,
      // `./images/${name}.png` would read as the dotfile `./images/.png`, which has no
      // extension, and be dropped; the images it names would then look dead, since their
      // names appear nowhere in the source for the sweep to find.
      const references = find('const src = `./images/${name}.png`;');

      expect(references.map((reference) => reference.rawPath)).toEqual(['./images/${name}.png']);
    });

    it('still rejects a template that is not path-shaped', () => {
      // The control: reading holes as `*` must not make everything look like a path.
      expect(find('const label = `${count} items`;')).toEqual([]);
      expect(find('const key = `user:${id}`;')).toEqual([]);
    });
  });

  describe('a template wearing a code extension', () => {
    // eleventy-docs keeps Nunjucks snippets in `.js` and `.cjs` files that open with
    // `{% raw %}`, which Eleventy includes as text. Failing to parse them is correct, but
    // "Unexpected token (1:1)" would tell a reader their JavaScript is broken when the
    // file was never JavaScript.

    it.each([
      ['{% raw %}', 'Nunjucks, Jinja or Liquid'],
      // `{{ title }}` alone is valid JavaScript (nested blocks around an expression), so it
      // parses and never reaches this message. A real Handlebars file opens with a helper,
      // and Babel rejects the `#`.
      ['{{#each items}}', 'Handlebars, Mustache or Vue'],
      ['<% if (x) { %>', 'EJS or ERB'],
    ])('names the syntax when a file starts with %s', (opener, syntax) => {
      let message = '';
      try {
        javascriptAdapter.findReferences({
          file: '/p/snippet.js',
          text: `${opener}
body`,
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toContain(syntax);
      expect(message).not.toContain('Unexpected token');
    });

    it('leaves the parser message alone when the file is just broken JavaScript', () => {
      // The control. This only runs after Babel has already failed, and it must not
      // start guessing about ordinary syntax errors.
      let message = '';
      try {
        javascriptAdapter.findReferences({ file: '/p/broken.js', text: 'const x = ;;;' });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).not.toContain('template source');
    });

    it('says nothing about a file that parses, however it starts', () => {
      // The template check runs only after a parse failure, so `{{` in a file that parses
      // is never read as a template opener.
      expect(() =>
        javascriptAdapter.findReferences({ file: '/p/ok.js', text: 'const t = `{{ x }}`;' }),
      ).not.toThrow();
    });
  });

  /**
   * Files uploaded through a CMS or dragged into a project carry spaces, and an image
   * whose path goes unread is reported dead. Both directions are asserted, because a
   * space is allowed only where prose stays out. See "What counts as a path-shaped
   * string" in ARCHITECTURE.md.
   */
  describe('a space in a filename', () => {
    const found: ReadonlyArray<[name: string, source: string, expected: readonly string[]]> = [
      [
        'a served path in an array',
        'const g = ["/ncc/Firing Practice.webp"];',
        ['/ncc/Firing Practice.webp'],
      ],
      [
        'a served path in an object property',
        'const g = { src: "/research/events/SPARK 2.jpg" };',
        ['/research/events/SPARK 2.jpg'],
      ],
      [
        'two spaces in one filename',
        'const g = ["/img/Annual Sports Day.jpg"];',
        ['/img/Annual Sports Day.jpg'],
      ],
      [
        'a template literal with a space',
        'const g = `/gallery/Firing Practice ${n}.webp`;',
        ['/gallery/Firing Practice ${n}.webp'],
      ],
    ];

    it.each(found)('finds %s', (_name, source, expected) => {
      expect(paths(source)).toEqual(expected);
      // The range must still slice the path back out: a spaced path is exactly where an
      // off-by-one would corrupt a file at rewrite time.
      expect(slices(source)).toEqual(expected);
    });

    const ignored: ReadonlyArray<[name: string, source: string]> = [
      // Each of these contains both a space and a `/`, so the slash rule alone cannot
      // reject them. What separates them is that prose continues after the extension.
      [
        'prose that continues past the extension',
        'const m = { note: "see ./old.png for details" };',
      ],
      ['an import statement quoted as text', `const s = "import logo from './old.png'";`],
      ['prose in a template literal', 'const msg = `we removed ./old.png last week`;'],
      // Accessible button labels like these, common in shadcn-ui, carry no slash. Taking
      // one for a path would put a rewritable reference on a piece of UI text.
      ['an accessible UI label naming a file', 'const label = "Remove workspace.png";'],
      ['another UI label', 'const label = "Open desk-reference.jpg";'],
      // A comma means a list, not a path: the unsplit srcSet shape.
      ['a srcSet-shaped candidate list', 'const s = "/a.jpg 1x, /b.jpg 2x";'],
    ];

    it.each(ignored)('ignores %s', (_name, source) => {
      expect(find(source)).toEqual([]);
    });

    /**
     * Parentheses. A browser appends ` (1)` to a duplicate download, so names such as
     * `WhatsApp Image 2026-03-11 at 1.29.35 PM (1).webp` are common. They are allowed only
     * in a string literal, which is already quoted: in an unquoted CSS `url(…)` or a bare
     * Markdown `![](…)` a parenthesis closes the construct. See "What counts as a
     * path-shaped string" in ARCHITECTURE.md.
     */
    it.each([
      [
        'a browser duplicate-download suffix',
        'const a = ["/img/Photo (1).webp"];',
        '/img/Photo (1).webp',
      ],
      [
        'a WhatsApp export, spaces and parens together',
        'const a = ["/e/WhatsApp Image 2026-03-11 at 1.29.35 PM (1).webp"];',
        '/e/WhatsApp Image 2026-03-11 at 1.29.35 PM (1).webp',
      ],
      ['parens with no space at all', 'const a = ["/img/photo(2).png"];', '/img/photo(2).png'],
    ])('finds %s', (_name, source, expected) => {
      expect(paths(source)).toEqual([expected]);
      expect(slices(source)).toEqual([expected]);
    });

    it('does not let the paren widening admit a function call', () => {
      // The end anchor is what keeps the widening safe: this ends on `)` rather than on an
      // extension, so it is not a filename and the spaced rule rejects it.
      expect(find('const s = "url(hero one.png)";')).toEqual([]);
      expect(find('const s = "call(a b.png) later";')).toEqual([]);

      // `"url(hero.png)"` is not asserted either way. With no space it never reaches the
      // spaced rule: it is emitted as a guess, and the resolver discards it because no file
      // of that name exists.
    });

    /**
     * The accepted gap. A spaced file name with no slash has the same shape as the UI
     * labels above (`'My Logo.svg'`, `'Remove workspace.png'`), so it stays invisible.
     * Closing it means dropping the `path.includes('/')` clause in `plausiblePathShape`,
     * which flips this expectation.
     */
    it('still misses a bare spaced filename with no separator, by design', () => {
      expect(find("const a = { file: 'My Logo.svg' };")).toEqual([]);
    });
  });

  /**
   * An inline `<svg>` in a JSX component is not an `.svg` file, so an SVG adapter would
   * never read its `<image href>`; only this adapter sees it.
   */
  describe('inline SVG in JSX', () => {
    const cases: ReadonlyArray<[name: string, source: string, expected: readonly string[]]> = [
      ['image href', '<image href="/a/hero.png" />', ['/a/hero.png']],
      ['image xlinkHref, the React spelling', '<image xlinkHref="/a/hero.png" />', ['/a/hero.png']],
      ['feImage href', '<feImage href="/a/hero.png" />', ['/a/hero.png']],
      ['image href in an expression container', '<image href={"/a/hero.png"} />', ['/a/hero.png']],
      ['image href built by a template', '<image href={`/a/${slug}.png`} />', ['/a/${slug}.png']],
    ];

    it.each(cases)('reads %s', (_name, source, expected) => {
      expect(paths(source)).toEqual(expected);
      expect(slices(source)).toEqual(expected);
    });

    it('does not turn every href into a candidate', () => {
      // The reason the map is keyed by tag rather than by attribute name: a bare `href`
      // set would have made every link a candidate, including links to non-images.
      expect(find('<a href="/a/report.pdf">x</a>')).toEqual([]);
      expect(find('<a href="/a/hero.png">x</a>')).toEqual([]);
    });
  });

  /**
   * A `+` chain is a template literal spelled differently, and it is read by the template's
   * rules: the same bound, the same globbing and the same external-URL test, all asked of
   * the path the chain assembles. See "Assembled paths in JavaScript" in ARCHITECTURE.md.
   */
  describe('a path assembled with +', () => {
    const TS = '/project/src/lib/paths.ts';

    function only(text: string, file = TS): RawReference {
      const found = find(text, file);
      expect(found).toHaveLength(1);
      return found[0] as RawReference;
    }

    it('reads a chain exactly as its template twin: the same pattern and the same ceiling', () => {
      const chain = only(
        "export const f = (width: number) => '/srcset/' + 'card-' + String(width) + '.jpg';",
      );
      const template = only('export const g = (width: number) => `/srcset/card-${width}.jpg`;');

      expect(chain.ceiling).toBe(template.ceiling);
      expect(chain.ceiling).toBe('medium');
      expect(chain.shape).toBe('js.concat.pattern');
      expect(template.shape).toBe('js.template.pattern');
      expect(chain.assembledPath).toBe('/srcset/card-${}.jpg');
      expect(chain.asserted).toBe(false);
      expect(chain.kind).toBe('string');
    });

    it('keeps the range on source text, outer quotes excluded as a template excludes backticks', () => {
      const text = "export const f = (w: number) => '/srcset/' + 'card-' + String(w) + '.jpg';";
      const chain = only(text);
      expect(text.slice(chain.start, chain.end)).toBe(chain.rawPath);
      expect(chain.rawPath).toBe("/srcset/' + 'card-' + String(w) + '.jpg");
    });

    it('ends the range on an unknown last piece without trimming anything from it', () => {
      const text = "export const f = (n: string, v: string) => '/img/' + n + '.png?v=' + v;";
      const chain = only(text);
      expect(chain.rawPath).toBe("/img/' + n + '.png?v=' + v");
      expect(text.slice(chain.start, chain.end)).toBe(chain.rawPath);
    });

    it('is dynamic where its template twin is: a leading unknown, or two unknowns in the name', () => {
      const leading = only(
        "export const f = (base: string, size: number) => base + '/icon-' + size + '.png';",
      );
      expect(leading.ceiling).toBe('unsafe');
      expect(leading.shape).toBe('js.concat.dynamic');
      expect(leading.assembledPath).toBe('${}/icon-${}.png');

      const twoInName = only(
        "export const f = (t: string, s: string) => '/icons/' + t + '-' + s + '.png';",
      );
      expect(twoInName.ceiling).toBe('unsafe');
    });

    it('collects nothing where the static text shows no extension: a route, a key, a namespace', () => {
      for (const text of [
        "export const f = (albumId: string) => router.push('/gallery/' + albumId);",
        "export const f = (id: string) => '/api/users/' + id;",
        "export const f = (eventType: string, space: string) => eventType + '.' + space;",
        'export const f = (type: string) => `report.${type}`;',
        'export const f = (n: number) => `v1.2.0-beta.${n}`;',
      ]) {
        expect(find(text, TS)).toEqual([]);
      }
    });

    it('collects nothing that is not path-shaped, even with an extension on the end', () => {
      expect(find("export const f = (x: string) => 'see ' + x + ' for the logo.png';", TS)).toEqual(
        [],
      );
    });

    it('leaves a literal that is already a complete path to the string rule: it re-reads nothing', () => {
      const literal = only("export const f = (v: string) => '/img/hero.jpg' + '?v=' + v;");
      expect(literal.rawPath).toBe('/img/hero.jpg');
      expect(literal.shape).toBe('js.string.literal');
      expect(literal.ceiling).toBe('high');
      expect(literal.assembledPath).toBeUndefined();

      const template = only("export const f = (n: string) => `/img/${n}.png` + '?v=2';");
      expect(template.shape).toBe('js.template.pattern');
      expect(template.assembledPath).toBeUndefined();
    });

    it('reads a chain once, whole, never again as the shorter chains inside it', () => {
      const chain = only(
        "export const f = (b: string, d: string) => '/a/' + b + '/c-' + d + '.png';",
      );
      expect(chain.assembledPath).toBe('/a/${}/c-${}.png');
    });

    it('treats a parenthesised sum as one unknown, because the brackets may add numbers', () => {
      const chain = only("export const f = (i: number) => '/img/' + (i + 1) + '.png';");
      expect(chain.assembledPath).toBe('/img/${}.png');
      expect(chain.ceiling).toBe('medium');
    });

    it('stops at a parenthesised chain on the left, and at an operator that is not +', () => {
      const chain = only(
        "export const f = (d: string, n: string) => ('/img/' + d) + '/' + n + '.png';",
      );
      expect(chain.assembledPath).toBe('${}/${}.png');

      const literal = only("export const f = (a: number, b: number) => a - b + '/x.png';");
      expect(literal.rawPath).toBe('/x.png');
    });

    it('takes a template with no holes as text, and a template with holes as one unknown', () => {
      const text = "export const f = (n: string) => `/img/` + n + '.png';";
      const plain = only(text);
      expect(plain.assembledPath).toBe('/img/${}.png');
      expect(text.slice(plain.start, plain.end)).toBe(plain.rawPath);
      expect(plain.rawPath.startsWith('/img/`')).toBe(true);

      const holed = only(
        "export const f = (d: string, n: string) => `/img/${d}` + '/' + n + '.png';",
      );
      expect(holed.assembledPath).toBe('${}/${}.png');
    });

    it("drops another server's file, judged by what the chain assembles", () => {
      expect(
        find("export const f = (n: string) => 'https://cdn.example.com/' + n + '.png';", TS),
      ).toEqual([]);
    });

    it('ignores a sum with no string in it', () => {
      expect(find('export const f = (a: number, b: number) => a + b + 1;', TS)).toEqual([]);
    });

    it('reads a chain inside a JSX src as a guess, with the same bound', () => {
      const chain = only(
        "export const I = ({ size }) => <img src={'/icons/icon-' + size + '.png'} alt=\"\" />;",
        '/project/src/components/I.jsx',
      );
      expect(chain.shape).toBe('js.concat.pattern');
      expect(chain.asserted).toBe(false);
    });
  });

  /**
   * A module constant is read through under one condition, which makes it sound without
   * scope analysis: the name's only binding in the whole file is a top-level `const` with
   * a string initialiser. See "Assembled paths in JavaScript" in ARCHITECTURE.md.
   */
  describe('same-file constants', () => {
    const TS = '/project/src/lib/paths.ts';

    it('reads a top-level string const through, in a chain and in a template alike', () => {
      const text = [
        "const ASSET_BASE = '/gallery';",
        "export const a = (name: string) => ASSET_BASE + '/' + name + '.png';",
        'export const b = (name: string) => `${ASSET_BASE}/${name}.png`;',
      ].join('\n');
      const [chain, template] = find(text, TS);

      expect(chain?.shape).toBe('js.concat.pattern');
      expect(chain?.assembledPath).toBe('/gallery/${}.png');
      expect(chain?.rawPath.startsWith('ASSET_BASE + ')).toBe(true);
      expect(template?.shape).toBe('js.template.pattern');
      expect(template?.ceiling).toBe('medium');
      expect(template?.assembledPath).toBe('/gallery/${}.png');
      expect(template?.rawPath).toBe('${ASSET_BASE}/${name}.png');
    });

    it('reads an exported const too', () => {
      const text = [
        "export const DIR = '/img';",
        "export const c = (n: string) => DIR + '/' + n + '.png';",
      ].join('\n');
      expect(find(text, TS)[0]?.assembledPath).toBe('/img/${}.png');
    });

    it('never reads a name with a second binding, whatever form the second one takes', () => {
      const shadows = [
        'function f1(P: string) { return P; }',
        'function f2({ O }: { O: string }) { return O; }',
        'function f3({ ...A }: object) { return A; }',
        'function f4([, D]: string[]) { return D; }',
        "function f5(R = '/x') { return R; }",
        'function f6(...V: string[]) { return V; }',
        'try { f1(1); } catch (C) { f1(C); }',
        'try { f1(1); } catch { f1(2); }',
        '{ class K {} }',
        '{ function G() {} }',
        'const g1 = function F() {};',
        'const g2 = function () {};',
        'const h1 = class E {};',
        'const h2 = class {};',
        'const o = { m(M: string) { return M; } };',
        'class Z { q(Q: string) { return Q; } #p(T: string) { return T; } }',
        'class Y { constructor(private S: string) {} }',
        'const arrow = (W: string) => W;',
        'export default class {}',
      ];
      const names = [
        'P',
        'O',
        'A',
        'D',
        'R',
        'V',
        'C',
        'K',
        'G',
        'F',
        'E',
        'M',
        'Q',
        'T',
        'S',
        'W',
      ];
      const text = [
        ...names.map((name) => `const ${name} = '/${name.toLowerCase()}';`),
        "const U = '/u';",
        ...shadows,
        `export const uses = (n: string) => [${[...names, 'U'].map((name) => `${name} + '/' + n + '.png'`).join(', ')}];`,
      ].join('\n');

      const found = find(text, TS);
      expect(found).toHaveLength(names.length + 1);
      // Every shadowed name stays an unknown: a leading hole, so `dynamic`.
      expect(found.slice(0, names.length).every((ref) => ref.ceiling === 'unsafe')).toBe(true);
      // The control: nothing binds U twice, so it is read through.
      expect(found.at(-1)?.assembledPath).toBe('/u/${}.png');
    });

    it('never reads a let or a var, whose first value proves nothing about a later call', () => {
      const text = [
        "let L = '/l';",
        "var W = '/w';",
        "export const u = (n: string) => [L + '/' + n + '.png', W + '/' + n + '.png'];",
      ].join('\n');
      expect(find(text, TS).map((ref) => ref.ceiling)).toEqual(['unsafe', 'unsafe']);
    });

    it('reads only a string initialiser bound to a plain name', () => {
      const text = [
        'const N = 42;',
        "const [X] = ['/x'];",
        'const S = `/s`;',
        'declare const Y: string;',
        'export { N };',
        'export function e() {}',
        "export const u = (n: string) => [N + '/' + n + '.png', X + '/' + n + '.png', S + '/' + n + '.png', Y + '/' + n + '.png'];",
      ].join('\n');
      expect(find(text, TS).map((ref) => ref.ceiling)).toEqual([
        'unsafe',
        'unsafe',
        'unsafe',
        'unsafe',
      ]);
    });

    it("turns a path into another server's file when the const names another host", () => {
      const text = [
        "const CDN = 'https://cdn.example.com';",
        "export const a = (n: string) => CDN + '/' + n + '.png';",
        'export const b = (n: string) => `${CDN}/${n}.png`;',
      ].join('\n');
      // Without the constant the template would be `dynamic`; read through, it is external.
      expect(find(text, TS)).toEqual([]);
    });

    it('never makes a reference rewritable: fully read through, a template is still a pattern', () => {
      const text = ["const DIR = '/img';", 'export const u = `${DIR}/hero.png`;'].join('\n');
      const [template] = find(text, TS);
      expect(template?.ceiling).toBe('medium');
      expect(template?.assembledPath).toBe('/img/hero.png');
    });

    it('drops a directory path, judged by what the text proves, in an asserting position too', () => {
      // A path ending in `/` names a directory. Asked through the adapter here, rather than
      // of `provablyNotAFile` alone.
      expect(
        find(
          'export const f = (id) => <iframe src={`/scratch2/${id}/adminpanel/`} />;',
          '/p/a.jsx',
        ),
      ).toEqual([]);
      // Only the constant shows this is a directory: the source text ends in `}`.
      const traced = ["const DIR = '/docs/';", 'export const g = () => <iframe src={`${DIR}`} />;'];
      expect(find(traced.join('\n'), '/p/b.jsx')).toEqual([]);
    });

    it('pins the known hazard: a complete-path literal after an unknown is still read alone', () => {
      // A chain with an operand that is already a complete path is left to that literal, so
      // `DIR + '/hero.png'` is read as `/hero.png`, which is not the whole path.
      const text = ["const DIR = '/img';", "export const u = DIR + '/hero.png';"].join('\n');
      expect(paths(text, TS)).toEqual(['/hero.png']);
    });
  });
});

/**
 * MDX ends an ESM block at a blank line unless the code so far is unfinished. Babel and
 * acorn disagree about where an unfinished construct is reported, so the three answers are
 * pinned here against both of Babel's signals.
 */
describe('javaScriptParseOutcome', () => {
  it('says `parses` for code that parses', () => {
    expect(javaScriptParseOutcome("import a from './a.png';", '.jsx')).toBe('parses');
  });

  it.each([
    ['an open object, failing at the very end', ['export const a = {', '  b: 1,']],
    ['an import with no source yet', ['import x']],
    ['an open template, which Babel reports at its START', ['export const a = `x', '']],
    ['an open block comment, likewise', ['export const a = 1 /* note', '']],
    ['an open JSX body, likewise', ['export const X = <div>', '  text']],
  ])('says `incomplete` for %s', (_name, lines) => {
    expect(javaScriptParseOutcome(lines.join('\n'), '.jsx')).toBe('incomplete');
  });

  it.each([
    ['prose that begins with the keyword', ['export and option.']],
    ['a malformed declaration', ['export const = broken;']],
    // A string cannot cross a line, so more text never finishes it, and acorn does not
    // swallow it either.
    ['an unterminated string', ["export const a = 'x", '']],
  ])('says `invalid` for %s', (_name, lines) => {
    const text = lines.join('\n');
    expect(javaScriptParseOutcome(text, '.jsx')).toBe('invalid');
  });

  it('says `invalid` for a dialect it has no grammar for, rather than guessing one', () => {
    expect(javaScriptParseOutcome('const a = 1;', '.coffee')).toBe('invalid');
  });
});
