import { describe, expect, it } from 'vitest';
import type { RawReference } from '../types.js';
import { astroAdapter } from './astro.js';

/**
 * A braced attribute value in an Astro template body is JavaScript, and is read by the
 * JavaScript adapter, so ``<img src={`/theme-${mode}.png`} />`` is a pattern whose range
 * is the path itself, as the same template is in a `.tsx` file. Every case here is written
 * from reading the source, not from the output.
 */
function body(markup: string): { text: string; references: RawReference[] } {
  const text = `---\nconst mode = 'dark';\n---\n${markup}\n`;
  return { text, references: astroAdapter.findReferences({ file: '/site/Page.astro', text }) };
}

describe('Astro body expressions are read as JavaScript', () => {
  it('reads a template with one unknown segment in the name as a pattern, at the path itself', () => {
    const { text, references } = body('<img src={`/theme-${mode}.png`} alt="" />');
    const [reference] = references;

    expect(references).toHaveLength(1);
    expect(reference?.shape).toBe('js.template.pattern');
    expect(reference?.ceiling).toBe('medium');
    expect(reference?.rawPath).toBe('/theme-${mode}.png');
    expect(text.slice(reference?.start, reference?.end)).toBe(reference?.rawPath);
  });

  it('reads a string literal in braces as a body literal the author asserted', () => {
    const { text, references } = body('<img src={\'/img/a.png\'} alt="" />');
    const [reference] = references;

    expect(reference?.shape).toBe('astro.template.literal');
    expect(reference?.ceiling).toBe('high');
    expect(reference?.asserted).toBe(true);
    expect(text.slice(reference?.start, reference?.end)).toBe('/img/a.png');
  });

  it('reads an identifier as a value, not a path: the fence import is the reference', () => {
    expect(body('<img src={hero} alt="" />').references).toEqual([]);
  });

  it("does not claim somebody else's server: the external-URL rule applies here too", () => {
    const { references } = body(
      '<img src={`https://avatars.githubusercontent.com/u/${id}?s=64`} alt="" />',
    );
    expect(references).toEqual([]);
  });

  it('does not glob two unknowns in the name, or an unknown directory', () => {
    for (const markup of [
      '<img src={`/icons/${theme}-${size}.png`} alt="" />',
      '<img src={`${base}/theme-light.png`} alt="" />',
    ]) {
      const [reference] = body(markup).references;
      expect(reference?.shape, markup).toBe('js.template.dynamic');
      expect(reference?.ceiling, markup).toBe('unsafe');
    }
  });

  it("keeps today's reading for a value parse5 cut at a space, never a worse one", () => {
    // `{ … }` with spaces reaches the body reader as `{`, not braced at both ends.
    const { references } = body('<img src={ `/theme-${mode}.png` } alt="" />');
    expect(references.some((reference) => reference.shape.startsWith('js.template'))).toBe(false);
  });

  it("keeps today's reading when Babel rejects the expression", () => {
    const [reference] = body('<img src={a+} alt="" />').references;
    expect(reference?.rawPath).toBe('{a+}');
    expect(reference?.shape).toBe('astro.template.literal');
  });
});

describe('a preview image or an image link in an Astro body keeps its shape', () => {
  // The shape is the one mark the planner reads, so neither the body's label nor the
  // `src` the braced value is read as may replace it.
  it('as written in the markup', () => {
    const { references } = body(
      '<meta property="og:image" content="/img/banner.png" /><a href="/img/team.jpg">Team</a>',
    );
    expect(references.map((reference) => reference.shape)).toEqual([
      'html.meta.content.image',
      'html.a.href.image',
    ]);
  });

  it('as a braced value, whatever the expression yields', () => {
    for (const markup of [
      `<meta property="og:image" content={'/img/banner.png'} />`,
      '<meta property="og:image" content={`/img/banner.png`} />',
      '<meta property="og:image" content={`/img/banner-${mode}.png`} />',
    ]) {
      const { references } = body(markup);
      expect(
        references.map((reference) => reference.shape),
        markup,
      ).toEqual(['html.meta.content.image']);
    }
  });
});
