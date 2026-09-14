/**
 * The shape ladder, at the rungs R89 examined — and at the two it did NOT change.
 *
 * The ladder is `shapes.ts`'s rule applied to one function: a shape names the narrowest
 * thing whose breakage would take out that reference and not others. In `shapeOf` that
 * becomes an order — interpolation, then the constructs CSS owns, then the host, then
 * the dialect and the quoting.
 *
 * 🔴 **Three entries in the coverage key disagreed with this code and the CODE WAS RIGHT
 * in all three, which is why these are assertions about the ladder rather than fixes.**
 * The key had `linear-gradient(...), url(...)` and `image-set(url(...) 1x)` both keyed
 * `css.url.nested`. The first is not nested at all — nothing recurses to reach a url at
 * the top level of a comma list — and the second is an image-set, which the key itself
 * says thirty lines earlier. The stated cause on record was *“the ladder order is
 * wrong”*, and reordering it would have changed NEITHER: `position.nested` is already
 * `false` in both. A fix that cannot work, with a message claiming it did.
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

describe('css.url.nested means the value walker RECURSED to reach it', () => {
  it('🔴 a url() at the top level of a comma-separated list is NOT nested', () => {
    // The stray. `linear-gradient(...)` is a sibling, not a parent: the url is a direct
    // child of the value, so it fails with every other plain double-quoted url() and
    // not with the cross-fade pair below.
    const source = '.a { background-image: linear-gradient(red, red), url("/img/banner.png"); }';

    expect(shapesOf(css(source))).toEqual(['css.url.double']);
  });

  it('a url() the walker had to recurse into IS nested', () => {
    const source = '.a { background-image: cross-fade(url("/a.png") 40%, url("/b.png")); }';

    expect(shapesOf(css(source))).toEqual(['css.url.nested', 'css.url.nested']);
  });

  it("a url() inside a custom property's fallback is nested too", () => {
    // A second recursion mechanism, which is what keeps the row from being one
    // function's test. `var()` is not `--x: url(…)`, which is `css.var`.
    const source = '.a { background-image: var(--promo, url("/img/banner.png")); }';

    expect(shapesOf(css(source))).toEqual(['css.url.nested']);
  });

  it('🔴 image-set wins over nesting, and the walker never marks it nested anyway', () => {
    // The second stray. Both readings were arguable from the key's prose; neither is
    // arguable from the code, which recurses into image-set WITHOUT setting `nested`.
    const source = '.a { mask-image: image-set(url(/icons/mask.svg) 1x); }';

    expect(shapesOf(css(source))).toEqual(['css.image-set']);
  });

  it('still marks a custom-property DECLARATION as css.var — the control', () => {
    // Without this, the `var()` assertion above would pass with the `--` rung deleted.
    const source = ':root { --masthead: url(/img/banner.png); }';

    expect(shapesOf(css(source))).toEqual(['css.var']);
  });
});

describe('a ${} inside CSS-in-JS stays on the host, and it is not the bug it looks like', () => {
  const styled = (value: string) =>
    javascriptAdapter.findReferences({
      file: '/project/src/styled.ts',
      text: `const A = styled.div\`\n  background-image: url('${value}');\n\`;\n`,
    });

  it('🔴 keeps js.cssinjs, because the CSS adapter never sees the ${}', () => {
    // Recorded as a misassignment (`js.template.pattern -> js.cssinjs`) and MEASURED to
    // be correct. `collectFromTaggedTemplate` flattens the template before handing it
    // over, substituting each interpolation with a same-length comment placeholder so the
    // offsets keep pointing into the real file — so `shapeOf` is given
    // `/theme-/*---*/.png`. A `${` rung in that ladder is unreachable code; one was
    // added, changed nothing, and was removed.
    const [reference] = styled('/theme-${mode}.png');

    expect(reference?.shape).toBe('js.cssinjs');
    expect(reference?.rawPath).toBe('/theme-/*---*/.png');
  });

  it('and the shape is RIGHT, because the pattern machinery never runs on it', () => {
    // `unsafe` is what makes `js.cssinjs` the only independently-failing thing here:
    // `resolveOne` refuses an unsafe reference outright, so no glob, no pattern row.
    // ⚠️ The coverage key expects `resolved-pattern` for this entry, which the engine
    // does not produce. That is a real divergence and it is the KEY's — raised with its
    // measured scope rather than patched from a probe of six entries.
    expect(styled('/theme-${mode}.png')[0]?.ceiling).toBe('unsafe');
  });

  it('leaves a literal url() inside CSS-in-JS on the host too — the control', () => {
    // Without it, the assertions above would pass with `hostShape` never applied.
    const [reference] = styled('/img/banner.png');

    expect(reference?.shape).toBe('js.cssinjs');
    expect(reference?.ceiling).toBe('high');
  });
});

describe('R80(b) reaches the CEILING, not just the label (R89)', () => {
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

  it('🔴 REFUSES to glob a name with two, which is the behaviour R80(b) ruled', () => {
    // The test that would have failed. Correcting `templateShape` alone made the shape
    // agree with the key while the reference went on claiming `icon-192.png` and
    // `icon-512.png` — a relabelling that reads as a fix. `resolveOne` globs on the
    // CEILING and never looks at the shape.
    const [reference] = template('/icons/${theme}-${size}.png');

    expect(reference?.shape).toBe('js.template.dynamic');
    expect(reference?.ceiling).toBe('unsafe');
  });

  it('says why in the note, because rule 9 makes a silent refusal a P0', () => {
    expect(template('/icons/${theme}-${size}.png')[0]?.note).toContain('R80(b)');
  });
});
