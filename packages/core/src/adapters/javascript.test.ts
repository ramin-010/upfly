import { describe, expect, it } from 'vitest';
import type { RawReference } from '../types.js';
import { javascriptAdapter } from './javascript.js';

/**
 * Table-driven, per the adapter contract.
 *
 * The most important group here is "never mistakes text for code": it is the group
 * that proves why §3.2 forbids parsing JavaScript with a regular expression. Each of
 * those cases contains a path that a regex would find and a parser will not.
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
      // Not a bundled asset, so not `certain` — but a runtime URL still 404s if the
      // file it names is converted and this line is not updated. Emitting it
      // speculative gets both: it links when the path resolves, and it is discarded
      // silently when it does not, so it can never become a false `broken`.
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
      // The adapter does not filter by extension — that policy lives in one place.
      expect(paths("import React from 'react';")).toEqual(['react']);
    });
  });

  describe('Node subpath imports', () => {
    it('keeps a #-prefixed import instead of dropping it as a fragment', () => {
      // A leading `#` is a document fragment nearly everywhere, but in a module
      // specifier it is a Node subpath import. Dropping it here made it vanish from
      // every report under no reason at all — a silent skip, which is a P0.
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
      // `-` is an escaped hyphen: babel decodes it, so the value is 9
      // characters where the source text is 14. No range points at the path, and a
      // rewrite computed from a mismatched range would corrupt the file.
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

  describe('templated URLs are external too (R21)', () => {
    /**
     * `skipPathChecks` means *suffix splitting would be wrong on this text*, which
     * is what its own comment says — and it was also skipping the external-URL
     * test. So every templated URL in a codebase became an `unsafe` reference, and
     * that bucket is what §1.1 shows users as "references I couldn't safely
     * rewrite". On `astro-docs` it held an npm registry call and a preview-branch
     * URL and **no images at all**.
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
      // The control, and the thing that must not break: a hole at the *start* is not
      // a scheme, so this is a local path the resolver globs.
      const references = find('const src = `${base}/img/hero.png`;');

      expect(references).toHaveLength(1);
      expect(references[0]?.ceiling).toBe('medium');
    });

    it('keeps a relative templated path whose hole is the whole filename stem', () => {
      // ⚠️ This never worked, and finding out why was worth more than the URL fix
      // above it. The guard joined the quasis with the holes **deleted**, so
      // `./images/${name}.png` became `./images/.png` — a dotfile, no extension,
      // dropped. Every `/images/${slug}.png` in a gallery or CMS data object went
      // the same way, and with no basename for the sweep to find, those assets were
      // reported *confidently dead*. The holes now become `*`, which is what the
      // resolver globs them to anyway.
      const references = find('const src = `./images/${name}.png`;');

      expect(references.map((reference) => reference.rawPath)).toEqual(['./images/${name}.png']);
    });

    it('still rejects a template that is not path-shaped', () => {
      // The control for that change: `*` must not make everything look like a path.
      expect(find('const label = `${count} items`;')).toEqual([]);
      expect(find('const key = `user:${id}`;')).toEqual([]);
    });
  });

  describe('a template wearing a code extension (R25 #4)', () => {
    // `eleventy-docs/src/_includes/snippets/pagination/**` are ten `.js` and `.cjs`
    // files opening with `{% raw %}` — Nunjucks source that Eleventy includes as
    // text. Failing to parse them is correct. "Unexpected token (1:1)" is not: it
    // tells a reader their JavaScript is broken when the file was never JavaScript.

    it.each([
      ['{% raw %}', 'Nunjucks, Jinja or Liquid'],
      // `{{ title }}` on its own is *valid* JavaScript — nested blocks around an
      // expression — so it parses and never reaches this message at all. A real
      // Handlebars file opens with a helper, and `#` is what Babel rejects.
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
      // `{{` inside a valid file is not this function's business — it is consulted
      // only after a parse failure, so a working file never reaches it.
      expect(() =>
        javascriptAdapter.findReferences({ file: '/p/ok.js', text: 'const t = `{{ x }}`;' }),
      ).not.toThrow();
    });
  });

  /**
   * R26 — a space in a filename made an image invisible, and the claim `dead` makes
   * depends on this.
   *
   * Found on a fourth repository (a university site, 2,052 images): 50 of 709 `dead`
   * findings were sampled against an independent grep and **8 were wrong, 16%** — seven
   * of the eight because the filename contained a space. Spaces are not an edge case in
   * the target market; they arrive with every CMS upload and every dragged-in file.
   *
   * ⚠️ **The guard that caused it stated a falsehood as fact:**
   * `// A module specifier never contains whitespace or a comma; neither does a path.`
   * The first clause is true, the second is not, and writing it as a certainty is why
   * nobody questioned it for the life of the adapter.
   *
   * Both directions are asserted here, because the fix is only correct if prose stays
   * out — and the first attempt at it (allow a space when there is also a `/`) let three
   * of `never mistakes text for code`'s cases through.
   */
  describe('a space in a filename — R26', () => {
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
      // Each of these contains both a space and a `/`, which is why the slash rule alone
      // was not enough. What separates them is that prose continues after the extension.
      [
        'prose that continues past the extension',
        'const m = { note: "see ./old.png for details" };',
      ],
      ['an import statement quoted as text', `const s = "import logo from './old.png'";`],
      ['prose in a template literal', 'const msg = `we removed ./old.png last week`;'],
      // Measured in shadcn-ui: 87 strings of this shape, 13 distinct, none with a slash.
      // They are accessible button labels, and treating one as a path would put a
      // rewritable reference on a piece of UI text.
      ['an accessible UI label naming a file', 'const label = "Remove workspace.png";'],
      ['another UI label', 'const label = "Open desk-reference.jpg";'],
      // A comma means a list, not a path — the unsplit srcSet shape.
      ['a srcSet-shaped candidate list', 'const s = "/a.jpg 1x, /b.jpg 2x";'],
    ];

    it.each(ignored)('ignores %s', (_name, source) => {
      expect(find(source)).toEqual([]);
    });

    /**
     * Parentheses, which the first version of this fix left out (R26 follow-up).
     *
     * `WhatsApp Image 2026-03-11 at 1.29.35 PM (1).webp` is a phone screenshot plus the
     * suffix every browser appends to a duplicate download — the commonest way a
     * non-developer gets an image into a repository. Measured on `RBU-Website`: **9 images
     * carry a paren and 4 were referenced and reported `dead` anyway**, which is why
     * §5.1(j) reads 0.7% rather than 0.0%.
     *
     * ⚠️ **Fixed only for the bare string literal, which is already a quoted context.** In
     * unquoted CSS `url(…)` and bare Markdown `![](…)` a paren is the closing delimiter,
     * and admitting it there breaks the parse — both have quoted and angle forms that
     * carry such a name correctly. Measured: of twelve reference positions only this one
     * lost a paren path.
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

      // ⚠️ Deliberately NOT asserting that `"url(hero.png)"` is rejected. Without a space it
      // never reaches the spaced rule at all — it is emitted as a speculative guess, as it
      // was before this change, and the resolver discards it because nothing of that name
      // exists. An earlier draft of this test claimed otherwise and was simply wrong about
      // the code; the behaviour is unchanged by the paren widening, which is the property
      // worth pinning.
    });

    /**
     * ⚠️ The known limit, pinned deliberately rather than fixed.
     *
     * A bare spaced filename with no separator is indistinguishable from the UI labels
     * above — `'My Logo.svg'` and `'Remove workspace.png'` have the same shape — so it
     * stays invisible. **Measured frequency across all four repositories: zero**; in the
     * university site all 109 spaced image paths contained a slash.
     *
     * This test documents the gap instead of leaving it silent. If a repository ever
     * needs it, the fix is to drop the `path.includes('/')` clause in
     * `plausiblePathShape`, and this expectation flips.
     */
    it('still misses a bare spaced filename with no separator, by design', () => {
      expect(find("const a = { file: 'My Logo.svg' };")).toEqual([]);
    });
  });

  /**
   * R26's second defect — `<image href>` in JSX.
   *
   * ARCHITECTURE.md recorded `<image href>` as a known gap **for `.svg` files**, which is
   * why nobody looked here: an inline `<svg>` in a JSX component is not an `.svg` file,
   * so no future SVG adapter would ever have covered it. Measured across the three
   * validation repos: **0 occurrences**, which is why §5.1 could not have found it.
   */
  describe('inline SVG in JSX — R26', () => {
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
});
