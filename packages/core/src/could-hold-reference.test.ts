import { describe, expect, it } from 'vitest';
import { couldHoldReference } from './could-hold-reference.js';

describe('couldHoldReference', () => {
  it('is false for text with none of the tokens', () => {
    expect(couldHoldReference('export function add(a: number, b: number) { return a + b; }')).toBe(
      false,
    );
  });

  it('is true when an image extension is present', () => {
    for (const ext of [
      '.avif',
      '.gif',
      '.jpeg',
      '.jpg',
      '.png',
      '.svg',
      '.tif',
      '.tiff',
      '.webp',
    ]) {
      expect(couldHoldReference(`const path = "./hero${ext}";`)).toBe(true);
    }
  });

  it('is case-insensitive for extensions', () => {
    expect(couldHoldReference('const path = "./HERO.PNG";')).toBe(true);
  });

  // R162's found risk: `url()` asserts a reference position even with a dynamic
  // argument and no extension anywhere in the file (css.ts:585, ceiling: 'unsafe',
  // reported today as a `dynamic` finding under rule 9). A file with none of the
  // extension tokens but a bare `url($var)` must not be skipped.
  it('is true for a dynamic CSS url() with no extension anywhere', () => {
    expect(couldHoldReference('.icon { background: url($icon-path); }')).toBe(true);
  });

  it('is true for image-set() with no extension', () => {
    expect(couldHoldReference('.icon { background: image-set($x); }')).toBe(true);
  });

  it('is true for an href-only file (covers xlink:href too)', () => {
    expect(couldHoldReference('<image xlink:href={dynamicRef} />')).toBe(true);
  });

  it('is true for a CSS-in-JS tag not covered by "style", e.g. keyframes', () => {
    expect(couldHoldReference('const spin = keyframes`${dynamicBody}`;')).toBe(true);
  });

  it('is false for prose containing no reference-shaped token', () => {
    expect(couldHoldReference('# Getting started\n\nRun `npm install` and read the docs.')).toBe(
      false,
    );
  });

  /**
   * 🔴 **R164/R165: the extension does not have to be spelled literally.**
   *
   * `resolve.ts` tests the extension against every spelling `spellingsOf` produces, so
   * each of these resolves to a real asset while holding no `.png` anywhere. Every one of
   * them was SKIPPED by the first version of this module — a reference the markdown
   * adapter finds, dropped with no error and no report line.
   *
   * ⚠️ **The last two are the ones R164's ruled token list would still have missed**, and
   * they are here because the lesson of that ruling is that fixing the spellings somebody
   * probed is not the same as fixing the class they belong to.
   */
  describe('an encoded extension still has to be parsed (R164, R165)', () => {
    it.each([
      ['a decimal entity dot', '![alt](hero&#46;png)'],
      ['a hex entity dot', '![alt](hero&#x2E;png)'],
      ['an entity dot in a link definition', '[label]: hero&#46;png'],
      ['a percent-encoded dot', '![alt](hero%2Epng)'],
      ['🔴 a percent-encoded extension LETTER, which `%2` misses', '![alt](hero.%70ng)'],
      ['🔴 a wholly percent-encoded extension', '![alt](hero%2E%70%6E%67)'],
    ])('%s', (_name, text) => {
      expect(couldHoldReference(text)).toBe(true);
    });
  });

  /**
   * A templated destination is a reference position with no static extension. It reaches
   * the report as `dynamic` (`ceiling: 'unsafe'`, and `provablyNotAnAsset` cannot rule it
   * out without an extension), so skipping the file deletes a required report line —
   * the `url($icon-path)` case in another dialect.
   */
  describe('a templated destination still has to be parsed (R165)', () => {
    it.each([
      ['Handlebars/Vue/Jinja', '![logo]({{ site.logo }})'],
      ['a Liquid tag', '![logo]({% asset_path logo %})'],
      ['EJS/ERB', '![logo](<%= logo %>)'],
      ['a template literal', '![logo](${logo})'],
      ['an interpolation', '![logo](#{logo})'],
    ])('%s', (_name, text) => {
      expect(couldHoldReference(text)).toBe(true);
    });
  });
});
