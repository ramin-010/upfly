/**
 * The shape ladder. A shape names the narrowest thing whose breakage would take out that
 * reference and no others, which in the CSS adapter's `shapeOf` becomes an order:
 * interpolation, then the constructs CSS owns, then the host, then the dialect and the
 * quoting. See "How a shape is chosen" in ARCHITECTURE.md.
 */

import { describe, expect, it } from 'vitest';
import type { RawReference } from '../types.js';
import { cssAdapter } from './css.js';
import { javascriptAdapter } from './javascript.js';

function css(text: string, file = '/project/styles.css'): RawReference[] {
  return cssAdapter.findReferences({ file, text });
}

function shapesOf(references: readonly RawReference[]): string[] {
  return references.map((reference) => reference.shape);
}

describe('css.url.nested means the value walker recursed to reach it', () => {
  it('a url() at the top level of a comma-separated list is not nested', () => {
    // `linear-gradient(...)` is a sibling, not a parent: the url is a direct child of the
    // value, so it breaks with every other plain double-quoted url(), not with the
    // cross-fade pair below.
    const source = '.a { background-image: linear-gradient(red, red), url("/img/banner.png"); }';

    expect(shapesOf(css(source))).toEqual(['css.url.double']);
  });

  it('a url() the walker had to recurse into is nested', () => {
    const source = '.a { background-image: cross-fade(url("/a.png") 40%, url("/b.png")); }';

    expect(shapesOf(css(source))).toEqual(['css.url.nested', 'css.url.nested']);
  });

  it("a url() inside a custom property's fallback is nested too", () => {
    // A second recursion mechanism, which is what keeps the row from being one
    // function's test. `var()` is not `--x: url(…)`, which is `css.var`.
    const source = '.a { background-image: var(--promo, url("/img/banner.png")); }';

    expect(shapesOf(css(source))).toEqual(['css.url.nested']);
  });

  it('image-set wins over nesting, and the walker never marks it nested anyway', () => {
    const source = '.a { mask-image: image-set(url(/icons/mask.svg) 1x); }';

    expect(shapesOf(css(source))).toEqual(['css.image-set']);
  });

  it('still marks a custom-property declaration as css.var (the control)', () => {
    // Without this, the `var()` assertion above would pass with the `--` rung deleted.
    const source = ':root { --masthead: url(/img/banner.png); }';

    expect(shapesOf(css(source))).toEqual(['css.var']);
  });
});

describe('a ${} inside CSS-in-JS is a pattern when the glob rule says so', () => {
  const styled = (value: string) =>
    javascriptAdapter.findReferences({
      file: '/project/src/styled.ts',
      text: `const A = styled.div\`\n  background-image: url('${value}');\n\`;\n`,
    });

  it('globs one unknown segment in the name, exactly as a template literal elsewhere does', () => {
    // The CSS pass sees a comment where the `${}` was and calls the url dynamic, so the
    // JavaScript adapter asks `assembledPathIsGlobbable` itself.
    const [reference] = styled('/theme-${mode}.png');

    expect(reference?.shape).toBe('js.template.pattern');
    expect(reference?.ceiling).toBe('medium');
  });

  it('carries the source text as its path, so the range invariant holds again', () => {
    // The placeholder is the CSS pass's device, not the file's text. As a path it would
    // break `source.slice(start, end) === rawPath`, and the resolver's pattern matcher
    // reads `${…}`, never `/*---*/`.
    const text = "const A = styled.div`\n  background-image: url('/theme-${mode}.png');\n`;\n";
    const [reference] = javascriptAdapter.findReferences({ file: '/project/src/styled.ts', text });

    expect(reference?.rawPath).toBe('/theme-${mode}.png');
    expect(text.slice(reference?.start, reference?.end)).toBe(reference?.rawPath);
  });

  it('does not glob a leading interpolation, because the directory varies', () => {
    // The refuting control: a pass that globbed every interpolated url would sweep
    // `*/theme-light.png` across every app in a monorepo.
    const [reference] = styled('${base}/theme-light.png');

    expect(reference?.shape).toBe('js.cssinjs');
    expect(reference?.ceiling).toBe('unsafe');
    expect(reference?.rawPath).toBe('${base}/theme-light.png');
  });

  it('leaves a literal url() inside CSS-in-JS on the host too (the control)', () => {
    // Without it, the assertions above would pass with `hostShape` never applied.
    const [reference] = styled('/img/banner.png');

    expect(reference?.shape).toBe('js.cssinjs');
    expect(reference?.ceiling).toBe('high');
  });
});

describe('the one-unknown-segment rule sets the ceiling, not just the shape', () => {
  const template = (value: string) =>
    javascriptAdapter.findReferences({
      file: '/project/src/paths.ts',
      text: `export const P = \`${value}\`;\n`,
    });

  it('globs a name with one unknown segment', () => {
    const [reference] = template('/theme-${mode}.png');

    expect(reference?.shape).toBe('js.template.pattern');
    expect(reference?.ceiling).toBe('medium');
  });

  it('refuses to glob a name with two unknown segments', () => {
    // `resolveOne` globs on the ceiling and never looks at the shape, so a fix to the shape
    // alone would leave the reference claiming `icon-192.png` and `icon-512.png`.
    const [reference] = template('/icons/${theme}-${size}.png');

    expect(reference?.shape).toBe('js.template.dynamic');
    expect(reference?.ceiling).toBe('unsafe');
  });

  it('says why in the note, because every refusal reaches the report with a reason', () => {
    expect(template('/icons/${theme}-${size}.png')[0]?.note).toContain(
      'at most one unknown part in the file name',
    );
  });
});
