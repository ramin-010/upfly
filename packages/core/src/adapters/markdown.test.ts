import { describe, expect, it } from 'vitest';
import { UpflyError } from '../errors.js';
import type { RawReference } from '../types.js';
import { markdownAdapter } from './markdown.js';

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

  describe('raw-text elements mentioned in prose (R20)', () => {
    // Markdown hands its text to the HTML adapter, and parse5 is a real HTML parser:
    // `<script>` opens a **raw-text element** wherever it appears, so prose that
    // merely mentions one swallows the rest of the document. Found on
    // `shadcn-ui/skills/migrate-radix-to-base/SKILL.md:67` — "retargeting onto a
    // base-<style> variant" — and in astro-docs's Korean config reference.
    //
    // Every layer is individually correct. The composition is what is wrong.

    const TAGS = ['style', 'script', 'textarea', 'title', 'plaintext', 'xmp'] as const;

    it.each(TAGS)('does not swallow the document after a bare <%s> in prose', (tag) => {
      // The dangerous half, and it is the *quiet* one: for five of these six there is
      // no error at all. A raw `<img>` after the mention is simply gone — a silent
      // skip, which rule 9 makes a P0.
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
      // The mask keys on *unclosed*, so a real `<style>` block is untouched and the
      // CSS inside it is still scanned. Without this the fix would be a silent skip
      // of its own, in the other direction.
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
      // A *closed* `<style>` whose CSS will not parse still throws, which is right —
      // rule 9 wants the failure visible. What must not happen is the four images
      // above it disappearing with it, which is what made the asset look dead.
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
      // The existing masker runs first, so a backticked `<style>` never reaches this
      // rule at all. Asserted so a future change to the mask order shows up here.
      const text = ['# Guide', '', 'use the `<style>` element', '', '![hero](./hero.png)'].join(
        '\n',
      );

      expect(
        markdownAdapter.findReferences({ file: 'guide.md', text }).map((r) => r.rawPath),
      ).toEqual(['./hero.png']);
    });
  });

  describe('fence tracking follows CommonMark (R21)', () => {
    /**
     * Getting a fence boundary wrong does not lose one reference — it **inverts the
     * mask** from that point to the end of the file. Everything fenced becomes live
     * and everything live becomes fenced, so the same defect produces a false
     * positive and a false negative at once, with no error either way.
     *
     * Found by chasing why `astro-docs`' unsafe bucket was full of CSP headers. Those
     * sit inside a ```html block; the mask had come out of step six hundred lines
     * earlier, at a ```ts fence.
     *
     * Each case asserts the same thing: the fenced example must not be a reference,
     * and the live one after it must still be found.
     */

    it('does not let an info-string fence close a block — it may only open one', () => {
      // `api-reference.mdx` opens fences with ```astro and ```ts title="…" all the
      // way down. Reading one of those as a *close* is what desynchronised it.
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
      // How a ```` block quotes a ``` block, which is what documentation *about*
      // Markdown does constantly — including ours.
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
      // This rule was already right. Asserted so it stays right.
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
      // fix must not make blocks impossible to end.
      const text = ['```', '![example](./fenced.png)', '`````', '', '![real](./real.png)'].join(
        '\n',
      );

      expect(find(text).map((reference) => reference.rawPath)).toEqual(['./real.png']);
    });

    it('still masks an ordinary fenced block, indented or not', () => {
      // The control. A fix that stopped masking anything would pass three of the
      // four assertions above.
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
