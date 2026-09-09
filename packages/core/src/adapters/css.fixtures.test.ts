import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cssAdapter } from './css.js';

/**
 * The adapter contract requires a fixture directory alongside the table-driven
 * tests. The tables above prove individual behaviours in isolation; these files
 * prove the adapter on stylesheets shaped like ones people actually write, where
 * comments, media queries, nesting and preprocessor syntax all appear at once.
 *
 * The adapter still never touches a disk — the test reads the file and hands over
 * text, which is exactly how the engine will call it.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/css');

function referencesIn(fixture: string) {
  const file = join(FIXTURES, fixture);
  const text = readFileSync(file, 'utf8');
  const references = cssAdapter.findReferences({ file, text });
  return references.map((reference) => ({
    path: reference.rawPath,
    ceiling: reference.ceiling,
    // Slicing the source with the reference's own range proves the offsets are right.
    slice: text.slice(reference.start, reference.end),
  }));
}

describe('cssAdapter fixtures', () => {
  it('reads site.css', () => {
    expect(referencesIn('site.css')).toEqual([
      { path: '/images/hero.png', ceiling: 'high', slice: '/images/hero.png' },
      { path: '../assets/noise.webp', ceiling: 'high', slice: '../assets/noise.webp' },
      { path: './textures/card.jpg', ceiling: 'high', slice: './textures/card.jpg' },
      { path: '../assets/border.png', ceiling: 'high', slice: '../assets/border.png' },
      { path: './textures/card.jpg', ceiling: 'high', slice: './textures/card.jpg' },
      { path: './textures/card@2x.jpg', ceiling: 'high', slice: './textures/card@2x.jpg' },
      // The `?v=4` is deliberately outside the range so a rewrite preserves it.
      { path: '/images/logo.svg', ceiling: 'high', slice: '/images/logo.svg' },
      { path: '../assets/card-wide.png', ceiling: 'high', slice: '../assets/card-wide.png' },
      // A font, not an image. The adapter reports it; filtering by kind is the
      // resolver's job, in one place, rather than each adapter's.
      { path: '../fonts/inter.woff2', ceiling: 'high', slice: '../fonts/inter.woff2' },
    ]);
  });

  it('reads theme.scss, keeping interpolation unsafe and line comments invisible', () => {
    expect(referencesIn('theme.scss')).toEqual([
      { path: '#{$image-dir}/hero.png', ceiling: 'unsafe', slice: '#{$image-dir}/hero.png' },
      { path: '../images/badge.png', ceiling: 'high', slice: '../images/badge.png' },
      { path: '../images/avatar.png', ceiling: 'high', slice: '../images/avatar.png' },
      { path: '../images/avatar@2x.png', ceiling: 'high', slice: '../images/avatar@2x.png' },
      { path: '$icon-path', ceiling: 'unsafe', slice: '$icon-path' },
      { path: '../images/child.png', ceiling: 'high', slice: '../images/child.png' },
    ]);
  });

  it('reads legacy.less', () => {
    expect(referencesIn('legacy.less')).toEqual([
      { path: '@{image-dir}/banner.png', ceiling: 'unsafe', slice: '@{image-dir}/banner.png' },
      { path: '../images/tile.png', ceiling: 'high', slice: '../images/tile.png' },
      { path: '../images/mixin.png', ceiling: 'high', slice: '../images/mixin.png' },
    ]);
  });

  it('finds no reference to anything that was commented out', () => {
    for (const fixture of ['site.css', 'theme.scss', 'legacy.less']) {
      const paths = referencesIn(fixture).map((reference) => reference.path);
      expect(paths.some((path) => path.includes('commented-out'))).toBe(false);
      expect(paths.some((path) => path.includes('deleted'))).toBe(false);
    }
  });
});
