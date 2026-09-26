import { describe, expect, it } from 'vitest';
import { UpflyError } from '../errors.js';
import type { RawReference } from '../types.js';
import { markdownAdapter, maskInactiveRegions } from './markdown.js';

function find(text: string, file = '/project/README.md'): RawReference[] {
  return markdownAdapter.findReferences({ file, text });
}

function paths(text: string): string[] {
  return find(text).map((reference) => reference.rawPath);
}

function slices(text: string): string[] {
  return find(text).map((reference) => text.slice(reference.start, reference.end));
}

describe('markdownAdapter', () => {
  it('claims the markdown extensions', () => {
    expect(markdownAdapter.id).toBe('markdown');
    expect(markdownAdapter.extensions).toEqual(['.md', '.mdx', '.markdown']);
  });

  describe('images and links', () => {
    const cases: ReadonlyArray<[name: string, source: string, expected: readonly string[]]> = [
      ['inline image', '![Logo](./logo.png)', ['./logo.png']],
      ['image with a title', '![Logo](./logo.png "The logo")', ['./logo.png']],
      ['image with single-quoted title', "![Logo](./logo.png 'The logo')", ['./logo.png']],
      ['angle-bracketed destination', '![Logo](<./my logo.png>)', ['./my logo.png']],
      ['empty alt text', '![](./logo.png)', ['./logo.png']],
      ['padded destination', '![Logo](  ./logo.png  )', ['./logo.png']],
      ['a plain link to an image', '[the diagram](./diagram.png)', ['./diagram.png']],
      ['root-relative path', '![Logo](/images/logo.png)', ['/images/logo.png']],
      ['parent-relative path', '![Logo](../images/logo.png)', ['../images/logo.png']],
      ['link reference definition', '[logo]: ./logo.png', ['./logo.png']],
      ['definition with a title', '[logo]: ./logo.png "The logo"', ['./logo.png']],
      ['definition, angle-bracketed', '[logo]: <./my logo.png>', ['./my logo.png']],
      ['two images on one line', '![a](./a.png) ![b](./b.png)', ['./a.png', './b.png']],
      [
        'image inside a list item',
        '- item one\n- ![Logo](./logo.png)\n- item three',
        ['./logo.png'],
      ],
      ['image inside a table cell', '| a | ![Logo](./logo.png) |', ['./logo.png']],
    ];

    it.each(cases)('%s', (_name, source, expected) => {
      expect(paths(source)).toEqual([...expected]);
      expect(slices(source)).toEqual([...expected]);
    });

    it('marks a markdown image as high and asserted', () => {
      const [reference] = find('![Logo](./logo.png)');
      expect(reference?.ceiling).toBe('high');
      expect(reference?.asserted).toBe(true);
      expect(reference?.kind).toBe('md');
    });
  });

  describe('raw HTML inside markdown', () => {
    it('finds an img tag', () => {
      const source = 'Some prose.\n\n<img src="./logo.png" alt="Logo">\n';
      expect(paths(source)).toEqual(['./logo.png']);
      expect(slices(source)).toEqual(['./logo.png']);
    });

    it('finds a picture block with srcset', () => {
      const source = [
        '<picture>',
        '  <source srcset="./hero.avif 1x, ./hero@2x.avif 2x" type="image/avif">',
        '  <img src="./hero.jpg" alt="Hero">',
        '</picture>',
      ].join('\n');
      expect(paths(source)).toEqual(['./hero.avif', './hero@2x.avif', './hero.jpg']);
      expect(slices(source)).toEqual(['./hero.avif', './hero@2x.avif', './hero.jpg']);
    });

    it('finds both markdown and HTML references in one document', () => {
      const source = '![a](./a.png)\n\n<img src="./b.png">';
      expect(paths(source)).toEqual(['./a.png', './b.png']);
    });
  });

  describe('never mistakes documentation for a reference', () => {
    it('ignores an image inside a fenced code block', () => {
      const source = ['```markdown', '![old](./old.png)', '```', '', '![new](./new.png)'].join(
        '\n',
      );
      expect(paths(source)).toEqual(['./new.png']);
      expect(slices(source)).toEqual(['./new.png']);
    });

    it('ignores HTML inside a fenced code block', () => {
      const source = ['```html', '<img src="./old.png">', '```', '', '![new](./new.png)'].join(
        '\n',
      );
      expect(paths(source)).toEqual(['./new.png']);
    });

    it('handles tilde fences', () => {
      const source = ['~~~', '![old](./old.png)', '~~~', '', '![new](./new.png)'].join('\n');
      expect(paths(source)).toEqual(['./new.png']);
    });

    it('does not let a tilde fence close a backtick fence', () => {
      const source = ['```', '~~~', '![old](./old.png)', '```', '', '![new](./new.png)'].join('\n');
      expect(paths(source)).toEqual(['./new.png']);
    });

    it('handles a fence with an info string', () => {
      const source = ['```jsx title="App.jsx"', '![old](./old.png)', '```'].join('\n');
      expect(find(source)).toEqual([]);
    });

    it('ignores an inline code span', () => {
      expect(paths('Write `![alt](./old.png)` to embed. ![real](./real.png)')).toEqual([
        './real.png',
      ]);
    });

    it('ignores a double-backtick code span', () => {
      expect(paths('``![alt](./old.png)`` and ![real](./real.png)')).toEqual(['./real.png']);
    });

    it('ignores an HTML comment', () => {
      expect(paths('<!-- ![old](./old.png) -->\n![new](./new.png)')).toEqual(['./new.png']);
    });

    it('ignores a multi-line HTML comment', () => {
      const source = [
        '<!--',
        '![old](./old.png)',
        '<img src="./also-old.png">',
        '-->',
        '![new](./new.png)',
      ].join('\n');
      expect(paths(source)).toEqual(['./new.png']);
    });

    it('keeps offsets correct for content after a masked region', () => {
      // Masking replaces with spaces of identical length, so nothing after a fence
      // shifts. This is the assertion that proves it.
      const source = ['```', 'a lot of code here', '```', '![real](./real.png)'].join('\n');
      expect(slices(source)).toEqual(['./real.png']);
    });
  });

  describe('ignores things that are not local files', () => {
    const cases: ReadonlyArray<[name: string, source: string]> = [
      ['https URLs', '![Logo](https://cdn.example.com/logo.png)'],
      ['data URIs', '![Logo](data:image/png;base64,AAAA)'],
      ['protocol-relative URLs', '![Logo](//cdn.example.com/logo.png)'],
      ['anchors', '[section](#heading)'],
      ['an empty destination', '![Logo]()'],
      ['a reference-style use with no destination', '![Logo][logo]'],
    ];

    it.each(cases)('%s', (_name, source) => {
      expect(find(source)).toEqual([]);
    });
  });

  describe('templated paths', () => {
    it('reports a Jekyll or Hugo expression as unsafe', () => {
      const references = find('![Logo]({{ site.baseurl }}/logo.png)');
      expect(references).toHaveLength(1);
      expect(references[0]?.ceiling).toBe('unsafe');
      expect(references[0]?.note).toMatch(/Handlebars|Liquid/);
    });

    it('reports a Liquid tag as unsafe', () => {
      const references = find('![Logo]({% asset_path logo %})');
      expect(references[0]?.ceiling).toBe('unsafe');
    });
  });

  describe('query suffixes', () => {
    it('keeps the suffix outside the range', () => {
      const source = '![Logo](./logo.png?v=2)';
      expect(paths(source)).toEqual(['./logo.png']);
      expect(slices(source)).toEqual(['./logo.png']);
    });
  });

  describe('offsets are UTF-16 code units', () => {
    it('stays aligned after an emoji', () => {
      const source = '# Launch 🎉\n\n![Logo](./logo.png)';
      expect(slices(source)).toEqual(['./logo.png']);
    });

    it('handles a non-ASCII path', () => {
      const source = '![Logo](./héro-café.png)';
      expect(paths(source)).toEqual(['./héro-café.png']);
      expect(slices(source)).toEqual(['./héro-café.png']);
    });
  });

  describe('is pure and deterministic', () => {
    it('returns the same result for the same input', () => {
      const source = '![a](./a.png)\n<img src="./b.png">';
      expect(find(source)).toEqual(find(source));
    });

    it('returns references sorted by position', () => {
      const source = '<img src="./second.png">\n\n![third](./third.png)';
      const starts = find(source).map((reference) => reference.start);
      expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    });

    it('records the file it was given', () => {
      expect(find('![a](./a.png)', '/project/docs/guide.mdx')[0]?.file).toBe(
        '/project/docs/guide.mdx',
      );
    });
  });

  describe('rewrite', () => {
    it('replaces markdown and HTML paths in one pass', () => {
      const source = '![a](./a.png)\n<img src="./b.png">';
      const rewritten = markdownAdapter.rewrite({
        text: source,
        edits: find(source).map((reference) => ({
          start: reference.start,
          end: reference.end,
          replacement: reference.rawPath.replace('.png', '.webp'),
        })),
      });
      expect(rewritten).toBe('![a](./a.webp)\n<img src="./b.webp">');
    });

    it('is a no-op with no edits', () => {
      const source = '![a](./a.png)';
      expect(markdownAdapter.rewrite({ text: source, edits: [] })).toBe(source);
    });
  });

  describe('raw-text elements mentioned in prose', () => {
    // Markdown hands its text to the HTML adapter, and parse5 is a real HTML parser:
    // `<script>` opens a raw-text element wherever it appears, so prose that merely
    // mentions one ("retargeting onto a base-<style> variant") swallows the rest of the
    // document. Each layer is correct on its own; the composition is what goes wrong.

    const TAGS = ['style', 'script', 'textarea', 'title', 'plaintext', 'xmp'] as const;

    it.each(TAGS)('does not swallow the document after a bare <%s> in prose', (tag) => {
      // For five of these six there is no error at all: a raw `<img>` after the mention
      // is simply gone, with nothing in the report.
      const text = [
        '# Guide',
        '',
        `prose mentioning a <${tag}> element.`,
        '',
        '<img src="./after.png" alt="a">',
      ].join('\n');

      const references = markdownAdapter.findReferences({ file: 'guide.md', text });

      expect(references.map((reference) => reference.rawPath)).toContain('./after.png');
    });

    it('still reads a raw-text element that does close', () => {
      // Only a tag that never closes is masked, so a real `<style>` block is untouched and
      // its CSS still scanned. Masking every one would silently drop what real blocks hold.
      const text = [
        '# Guide',
        '',
        '<style>',
        '  .a { background: url(./in-css.png); }',
        '</style>',
      ].join('\n');

      const references = markdownAdapter.findReferences({ file: 'guide.md', text });

      expect(references.map((reference) => reference.rawPath)).toEqual(['./in-css.png']);
    });

    it('keeps the references it already found when the HTML hand-off throws', () => {
      // A closed `<style>` whose CSS will not parse still throws, which is right: the
      // failure has to reach the report. The references above it must survive the throw,
      // or their assets look dead.
      const text = [
        '# Guide',
        '',
        '![one](./one.png)',
        '![two](./two.png)',
        '',
        '<style>',
        '  a { color: ; ;; }} unclosed',
        '</style>',
      ].join('\n');

      let thrown: unknown;
      try {
        markdownAdapter.findReferences({ file: 'guide.md', text });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(UpflyError);
      expect((thrown as UpflyError).code).toBe('ADAPTER_PARSE_FAILED');
      expect((thrown as UpflyError).partial.map((r) => (r as RawReference).rawPath)).toEqual([
        './one.png',
        './two.png',
      ]);
    });

    it('leaves a mention inside a code span alone, as it always did', () => {
      // Code spans are masked first, so a backticked `<style>` never reaches the raw-text
      // rule. Asserted so a change to the mask order shows up here.
      const text = ['# Guide', '', 'use the `<style>` element', '', '![hero](./hero.png)'].join(
        '\n',
      );

      expect(
        markdownAdapter.findReferences({ file: 'guide.md', text }).map((r) => r.rawPath),
      ).toEqual(['./hero.png']);
    });
  });

  describe('fence tracking follows CommonMark', () => {
    /**
     * A fence boundary read wrongly inverts the mask to the end of the file: fenced
     * examples turn live and live references are blanked, a false positive and a false
     * negative at once, with no error either way. Each case asserts that the fenced
     * example is not a reference and the live one after it is still found.
     */

    it('does not let an info-string fence close a block: it may only open one', () => {
      // Documentation opens fences with ```astro or ```ts title="…" throughout, and
      // reading one of those as a close puts the mask out of step.
      const text = [
        '```',
        'inside a plain fence',
        '```ts',
        '![example](./fenced.png)',
        '```',
        '',
        '![real](./real.png)',
      ].join('\n');

      expect(find(text).map((reference) => reference.rawPath)).toEqual(['./real.png']);
    });

    it('does not let a shorter fence close a longer one', () => {
      // How a ```` block quotes a ``` block, as documentation about Markdown often does.
      const text = [
        '````',
        'showing how a fence works:',
        '```',
        '![example](./fenced.png)',
        '````',
        '',
        '![real](./real.png)',
      ].join('\n');

      expect(find(text).map((reference) => reference.rawPath)).toEqual(['./real.png']);
    });

    it('does not let a tilde fence be closed by a backtick fence', () => {
      const text = [
        '~~~',
        '```',
        '![example](./fenced.png)',
        '~~~',
        '',
        '![real](./real.png)',
      ].join('\n');

      expect(find(text).map((reference) => reference.rawPath)).toEqual(['./real.png']);
    });

    it('closes on a longer run of the same character', () => {
      // The other direction: a fence longer than its opener still closes it, so the
      // length rule must not make blocks impossible to end.
      const text = ['```', '![example](./fenced.png)', '`````', '', '![real](./real.png)'].join(
        '\n',
      );

      expect(find(text).map((reference) => reference.rawPath)).toEqual(['./real.png']);
    });

    it('still masks an ordinary fenced block, indented or not', () => {
      // None of the cases above indents its fence, and CommonMark allows up to three
      // spaces before one.
      const text = [
        'prose',
        '',
        '  ```js',
        '  ![example](./fenced.png)',
        '  ```',
        '',
        '![real](./real.png)',
      ].join('\n');

      expect(find(text).map((reference) => reference.rawPath)).toEqual(['./real.png']);
    });
  });
});

describe('maskInactiveRegions', () => {
  it('preserves length exactly, so an offset into one indexes the other', () => {
    const text = ['prose `code` more', '', '```js', 'const x = 1;', '```', ''].join('\n');

    expect(maskInactiveRegions(text)).toHaveLength(text.length);
  });

  it('preserves every newline, so line numbers survive masking', () => {
    const text = ['a', '```', 'b', 'c', '```', 'd'].join('\n');
    const countNewlines = (value: string) => [...value].filter((c) => c === '\n').length;

    expect(countNewlines(maskInactiveRegions(text))).toBe(countNewlines(text));
  });

  it('masks an import inside a fence: the defect this export exists to prevent', () => {
    // Documentation teaching a reader how to write an import is not an import.
    const text = ['```astro', "import stars from '~/stars/docline.png';", '```'].join('\n');

    expect(maskInactiveRegions(text)).not.toContain('docline.png');
  });

  it('masks a fence whose lines end CRLF', () => {
    // Split on `\n`, a CRLF line keeps its `\r`, so a pattern ending in `$` has to allow
    // for it or it misses every fence. Same input as the test above, with CRLF endings.
    const text = ['```astro', "import stars from '~/stars/docline.png';", '```'].join('\r\n');

    expect(maskInactiveRegions(text)).not.toContain('docline.png');
  });

  it('leaves text outside a fence alone (the control)', () => {
    // Proves the four assertions above can fail: a masker that blanked everything
    // would satisfy every `not.toContain` while being useless.
    const text = [
      "import real from './kept.png';",
      '',
      '```',
      "import fenced from './gone.png';",
      '```',
    ].join('\n');
    const masked = maskInactiveRegions(text);

    expect(masked).toContain('./kept.png');
    expect(masked).not.toContain('./gone.png');
  });
});

/**
 * The parse5 pass runs only when the masked document has markup, because parse5 is most
 * of the adapter's cost. The risk is skipping a document whose reference only parse5 can
 * see. These tests hold their own documents rather than rely on a fixture somebody else
 * maintains and could take away.
 */
describe('the parse5 pass is skipped only when there is nothing for it to find', () => {
  it('still finds a reference that only the HTML pass can see', () => {
    const text = '# Title\n\n<img src="/only-html.png" alt="">\n';
    const found = markdownAdapter.findReferences({ file: 'doc.md', text });

    // The Markdown regexes match `![alt](path)` and `[label]: path`. Neither can match
    // this, so if the skip fired wrongly the reference simply disappears.
    expect(found.map((reference) => reference.rawPath)).toEqual(['/only-html.png']);
    expect(found[0]?.shape).toBe('md.raw-html');
  });

  it('still finds one inside a style attribute, which is the subtlest shape', () => {
    const text = '# Title\n\n<div style="background-image: url(\'/bg.png\')"></div>\n';
    const found = markdownAdapter.findReferences({ file: 'doc.md', text });

    expect(found.map((reference) => reference.rawPath)).toEqual(['/bg.png']);
  });

  it('finds markdown references in a document with no markup at all', () => {
    const text = '# Title\n\n![alt](/a.png)\n\n[link](/b.png)\n';
    const found = markdownAdapter.findReferences({ file: 'doc.md', text });

    expect(found.map((reference) => reference.rawPath)).toEqual(['/a.png', '/b.png']);
  });

  /**
   * The case the skip exists for. Documentation keeps most of its markup in code fences,
   * which masking blanks, so the skip is decided on the masked text: a document whose
   * only `<img>` is fenced has nothing for the HTML pass to find, and the fenced one is
   * documentation, not a reference.
   */
  it('skips a document whose only markup is inside a fence, and reports nothing from it', () => {
    const text = '# Title\n\n```html\n<img src="/inside-a-fence.png">\n```\n\n![real](/real.png)\n';
    const found = markdownAdapter.findReferences({ file: 'doc.md', text });

    expect(found.map((reference) => reference.rawPath)).toEqual(['/real.png']);
  });

  /**
   * The guard is `<` followed by a letter, HTML's own tag-open condition, so a stray angle
   * bracket in prose is not markup and costs no parse. The test asserts the output rather
   * than whether the pass ran: the output is what a user sees, and `bench/` measures the
   * timing.
   */
  it('treats a bare `<` in prose as text, exactly as parse5 would', () => {
    const text = '# Title\n\n5 < 6 and 7 > 3\n\n![alt](/a.png)\n';
    const found = markdownAdapter.findReferences({ file: 'doc.md', text });

    expect(found.map((reference) => reference.rawPath)).toEqual(['/a.png']);
  });
});

/**
 * MDX's top-level `import`/`export` blocks are JavaScript and name assets
 * (`import hero from './hero.png'`). Where a block starts and ends follows MDX's own
 * rules (`micromark-extension-mdxjs-esm`), so a line these cases do not read as ESM is
 * one MDX does not read as ESM either.
 */
describe('MDX top-level ESM is read as JavaScript', () => {
  const mdx = (text: string) => markdownAdapter.findReferences({ file: '/site/post.mdx', text });
  const summary = (text: string) =>
    mdx(text).map((reference) => ({
      raw: reference.rawPath,
      shape: reference.shape,
      exact: text.slice(reference.start, reference.end) === reference.rawPath,
    }));

  it('finds image imports, stamped `mdx.import`, at exact offsets', () => {
    const text = [
      '---',
      'title: A post',
      '---',
      "import hero from '../public/hero.png';",
      "import thumb from '@img/thumb.png';",
      '',
      '# A post',
    ].join('\n');

    expect(summary(text)).toEqual([
      { raw: '../public/hero.png', shape: 'mdx.import', exact: true },
      // Alias-shaped. Which alias it is depends on the paths table, which the resolver
      // reads, so the adapter names only the construct.
      { raw: '@img/thumb.png', shape: 'mdx.import', exact: true },
    ]);
  });

  it('finds a path-shaped string in an `export const`, as a guess (the speculative rule)', () => {
    const text = "# A post\n\nexport const banner = '/img/hero.jpg';\n";
    const [found] = mdx(text);

    expect(found?.rawPath).toBe('/img/hero.jpg');
    expect(found?.shape).toBe('js.string.literal');
    expect(found?.asserted).toBe(false);
  });

  it('leaves an `import` inside a code fence inert: it is an example, not code', () => {
    const text = ['# Usage', '', '```mdx', "import hero from './hero.png';", '```', ''].join('\n');
    expect(mdx(text)).toEqual([]);
  });

  it('does not read a paragraph line that begins with the keyword: MDX cannot interrupt one', () => {
    // Prose can wrap onto a line that begins with the keyword ("lists every public\nexport
    // and option."). Read as code, that is a parse failure. The first case is worse: it is
    // valid JavaScript, so ignoring the paragraph would emit a phantom import, a wrong
    // answer the engine cannot catch in its own report.
    const phantom = 'The build step will\nimport hero from "./hero.png";\n';
    expect(mdx(phantom)).toEqual([]);

    const prose = 'This reference lists every public\nexport and option.\n\n![a](/a.png)\n';
    expect(summary(prose)).toEqual([{ raw: '/a.png', shape: 'md.image', exact: true }]);
  });

  it('opens only at column 1 and only on the keyword followed by one space', () => {
    const indented = "Some prose.\n\n  import hero from './hero.png';\n";
    const listed = "- import hero from './hero.png';\n";
    const glued = "Some prose.\n\nimport{hero}from'./hero.png';\n";
    expect(mdx(indented)).toEqual([]);
    expect(mdx(listed)).toEqual([]);
    expect(mdx(glued)).toEqual([]);
  });

  it('never reads ESM in a `.md` file, which has none', () => {
    const text = "import hero from './hero.png';\n";
    expect(markdownAdapter.findReferences({ file: '/site/post.md', text })).toEqual([]);
  });

  it('continues past a blank line only where MDX does: the code so far is unfinished', () => {
    const object = ['export const meta = {', '', "  image: '/img/a.png',", '};', ''].join('\n');
    expect(summary(object)).toEqual([
      { raw: '/img/a.png', shape: 'js.string.literal', exact: true },
    ]);

    // Babel positions an unfinished JSX body at its start, not at the end of the input,
    // so the test for "unfinished" has to read its reason code too.
    const jsx = [
      'export const Hero = () => (',
      '  <div>',
      '',
      '    <img src="/img/b.png" />',
      '  </div>',
      ');',
    ].join('\n');
    expect(summary(jsx)).toEqual([{ raw: '/img/b.png', shape: 'js.jsx.attribute', exact: true }]);
  });

  it('reads JSX inside an ESM block once, as JavaScript, never also as markup', () => {
    const text = 'export const Hero = () => <img src="/img/c.png" />;\n';
    expect(summary(text)).toEqual([{ raw: '/img/c.png', shape: 'js.jsx.attribute', exact: true }]);
  });

  it('reports a block MDX would refuse, and keeps everything else the document holds', () => {
    const text = [
      '![before](/before.png)',
      '',
      'export const = broken;',
      '',
      '![after](/after.png)',
    ].join('\n');

    let caught: unknown;
    try {
      mdx(text);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UpflyError);
    const failure = caught as UpflyError;
    expect(failure.code).toBe('ADAPTER_PARSE_FAILED');
    expect(
      (failure.partial as RawReference[]).map((reference) => reference.rawPath).sort(),
    ).toEqual(['/after.png', '/before.png']);
  });
});

/**
 * An indented code block is code shown, not run, like a fence, so an `<img>` inside one is
 * not raw HTML. Four spaces also mean a list item's own content, a paragraph carrying on,
 * or the inside of a `<pre>`, and every case below that stays live is one where a looser
 * rule would blank a real reference.
 */
describe('indented code blocks are masked, and only they are', () => {
  const md = (text: string) =>
    markdownAdapter.findReferences({ file: '/site/guide.md', text }).map((r) => r.rawPath);

  it('masks an indented block after a blank line: the case that was claimed', () => {
    const text = [
      'An example:',
      '',
      '    <img src="/in-code.png" alt="shown, not run">',
      '    ![also](/in-code-too.png)',
      '',
      '![real](/real.png)',
    ].join('\n');
    expect(md(text)).toEqual(['/real.png']);
  });

  it('masks every chunk of a block that a blank line interrupts', () => {
    const text = ['    <img src="/a.png">', '', '    <img src="/b.png">', ''].join('\n');
    expect(md(text)).toEqual([]);
  });

  it('masks a block that follows a heading directly: a heading is a whole block', () => {
    expect(md('# Example\n    <img src="/in-code.png">\n')).toEqual([]);
  });

  it('counts a tab as reaching the next multiple of four', () => {
    expect(md('Text.\n\n\t<img src="/tabbed.png">\n')).toEqual([]);
    expect(md('Text.\n\n  \t<img src="/tabbed.png">\n')).toEqual([]);
  });

  it("keeps a list item's indented continuation live: it is the item, not code", () => {
    const text = [
      '- A list item whose picture sits in its own paragraph:',
      '',
      '    <img src="/in-list.png" alt="a real reference">',
      '',
      '- A second item.',
      '',
      '        <img src="/deeper-in-list.png" alt="left live: nested code is not guessed at">',
    ].join('\n');
    expect(md(text)).toEqual(['/in-list.png', '/deeper-in-list.png']);
  });

  it('masks again once the list has ended', () => {
    const text = [
      '1. An ordered item.',
      '',
      'A paragraph at the margin, which ends the list.',
      '',
      '    <img src="/in-code.png">',
    ].join('\n');
    expect(md(text)).toEqual([]);
  });

  it("keeps a paragraph's indented next line live: indented code cannot interrupt one", () => {
    const text = 'A sentence that goes on\n    <img src="/lazy.png" alt="to the next line">\n';
    expect(md(text)).toEqual(['/lazy.png']);
  });

  it('keeps indented table rows live across a commented-out row (eleventy-docs cjs-esm.md)', () => {
    // The mask turns the comment into spaces, so reading the mask for blank lines would
    // end the HTML block there and blank the live rows after it.
    const text = [
      '<table>',
      '\t<tbody>',
      '\t\t<!-- <tr>',
      '\t\t\t<td>retired</td>',
      '\t\t</tr> -->',
      '\t\t<tr>',
      '\t\t\t<td><img src="/in-table.png" alt="live"></td>',
      '\t\t</tr>',
      '\t</tbody>',
      '</table>',
    ].join('\n');
    expect(md(text)).toEqual(['/in-table.png']);
  });

  it('keeps the inside of a <pre> live across a blank line: that HTML block does not end there', () => {
    const text = [
      '<pre>',
      'Output:',
      '',
      '    <img src="/in-pre.png" alt="rendered">',
      '</pre>',
    ].join('\n');
    expect(md(text)).toEqual(['/in-pre.png']);
  });

  it('does not treat a fence as a blank line, and does treat its end as the end of a block', () => {
    const text = ['```text', 'fenced', '```', '    <img src="/after-fence.png">'].join('\n');
    expect(md(text)).toEqual([]);
  });

  it('never masks anything in MDX, which has no indented code: JSX is indented', () => {
    const text = ['<div>', '', '    <img src="/in-jsx.png" alt="live" />', '', '</div>'].join('\n');
    const found = markdownAdapter.findReferences({ file: '/site/post.mdx', text });
    expect(found.map((reference) => reference.rawPath)).toEqual(['/in-jsx.png']);
  });

  it('leaves `maskInactiveRegions` exactly as it was unless asked, and exact in length when asked', () => {
    const text = 'Text.\n\n    <img src="/in-code.png">\n';
    expect(maskInactiveRegions(text)).toBe(text);
    const masked = maskInactiveRegions(text, { indentedCode: true });
    expect(masked).toHaveLength(text.length);
    expect(masked).not.toContain('in-code');
    expect(masked.split('\n')).toHaveLength(text.split('\n').length);
  });
});
