/**
 * R80(b)'s rule, which had been ruled and implemented nowhere.
 *
 * 🔴 **The test that would have failed, and the reason it did not exist.** Until R89 the
 * decision lived in `templateShape`, which asked only *“does the static prefix contain a
 * `/`”* — condition ONE of two. `/icons/${theme}-${size}.png` passed it, so the engine
 * called it a `pattern` while the ruled answer is `dynamic`, and a pattern claims files:
 * globbing it would sweep in `icon-192.png` and `icon-512.png` on a template that
 * constrains almost nothing.
 *
 * ⚠️ **The second reason to test it here rather than through an adapter.** The rule now
 * decides two different things about the same reference — its SHAPE (`templateShape`) and
 * its CEILING (`addTemplateReference`) — and only the ceiling changes behaviour. Getting
 * the two from one function is what stops a future relabelling from looking like a fix
 * again. Each is asserted against a real adapter in `shape-ladder.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { assembledPathIsGlobbable } from './reference-path.js';

/**
 * The rule, asked with a path rather than a chunk array, because a table of
 * `['', '/b-', '.png']` is unreadable and an unreadable table is how a case gets
 * written wrong. Splitting lives here rather than in shipped code: the engine's
 * callers already hold the chunks (a template literal's `quasis`), so a shipped
 * splitter would have had no consumer but this file.
 */
function globbable(path: string): boolean {
  return assembledPathIsGlobbable(path.split(/\$\{[^}]*\}/));
}

describe('assembledPathIsGlobbable', () => {
  describe('condition 1 — the directory must be fixed (R78 Q3)', () => {
    it.each([
      ['a leading interpolation', '${base}/hero.png'],
      ['a leading interpolation with a fixed name', '${ASSET_BASE}/${name}.png'],
      ['nothing static at all', '${everything}'],
    ])('%s is not globbable', (_name, path) => {
      expect(globbable(path)).toBe(false);
    });
  });

  describe('condition 2 — enough of the NAME must be fixed (R80(b))', () => {
    it('accepts one unknown segment in the name', () => {
      expect(globbable('/theme-${mode}.png')).toBe(true);
      expect(globbable('/srcset/tile@${density}x.png')).toBe(true);
    });

    it('🔴 REFUSES two unknown segments in the name — the case R80(b) ruled', () => {
      // The ruled answer is `dynamic`. The directory is fixed and the name is not:
      // `/icons/*-*.png` constrains almost nothing, so claiming its matches would
      // claim assets nobody referenced.
      expect(globbable('/icons/${theme}-${size}.png')).toBe(false);
    });

    it('refuses three, so the bound is a bound and not an off-by-one', () => {
      expect(globbable('/img/${a}-${b}-${c}.png')).toBe(false);
    });
  });

  describe('unknowns in a DIRECTORY segment are not unknowns in the name', () => {
    it('counts only what follows the last slash', () => {
      // Two interpolations, one of them a directory. The name has one unknown, so the
      // glob is still anchored by a filename pattern.
      expect(globbable('/img/${dir}/hero-${size}.png')).toBe(true);
    });

    it('accepts a fully fixed name after a varying directory segment', () => {
      expect(globbable('/img/${dir}/hero.png')).toBe(true);
    });
  });

  describe('the degenerate inputs, stated rather than assumed', () => {
    it('treats a path with no unknown segments as globbable', () => {
      expect(assembledPathIsGlobbable(['/img/hero.png'])).toBe(true);
    });

    it('refuses an empty chunk list rather than throwing', () => {
      expect(assembledPathIsGlobbable([])).toBe(false);
    });
  });
});
