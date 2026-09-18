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
});
