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

  // `url()` marks a reference position even when its argument is a variable and the file
  // holds no extension. Such a reference is reported as `dynamic`, so a file whose only
  // token is `url($var)` must still be parsed.
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

  // `resolve.ts` tests the extension against every spelling `spellingsOf` produces, so each
  // of these resolves to a real asset with no `.png` in the text. Skipping the file would
  // drop a reference the markdown adapter finds, with no error and no report line.
  // Percent-decoding applies to any character, so some cases escape letters of the extension.
  describe('an encoded extension still has to be parsed', () => {
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

  // A templated destination is a reference position with no static extension. It is
  // reported as `dynamic`, since `provablyNotAnAsset` cannot rule it out without an
  // extension, so skipping the file would drop that report line.
  describe('a templated destination still has to be parsed', () => {
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
