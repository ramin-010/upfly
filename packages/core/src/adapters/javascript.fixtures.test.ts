import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { javascriptAdapter } from './javascript.js';

/**
 * The fixture the adapter contract asks for: a component shaped like one someone
 * would actually write, where imports, CSS-in-JS, JSX, templates, comments and
 * prose strings all appear together.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/javascript');

function referencesIn(fixture: string) {
  const file = join(FIXTURES, fixture);
  const text = readFileSync(file, 'utf8');
  return javascriptAdapter.findReferences({ file, text }).map((reference) => ({
    path: reference.rawPath,
    ceiling: reference.ceiling,
    slice: text.slice(reference.start, reference.end),
  }));
}

describe('javascriptAdapter fixtures', () => {
  it('reads Gallery.jsx', () => {
    expect(referencesIn('Gallery.jsx')).toEqual([
      { path: 'react', ceiling: 'certain', slice: 'react' },
      { path: 'styled-components', ceiling: 'certain', slice: 'styled-components' },
      { path: './assets/logo.png', ceiling: 'certain', slice: './assets/logo.png' },
      // The `?as=webp` suffix sits outside the range so a rewrite preserves it.
      { path: '../images/hero.jpg', ceiling: 'certain', slice: '../images/hero.jpg' },
      { path: './Gallery.css', ceiling: 'certain', slice: './Gallery.css' },
      { path: './assets/banner.avif', ceiling: 'high', slice: './assets/banner.avif' },
      { path: './assets/thumb.png', ceiling: 'certain', slice: './assets/thumb.png' },
      { path: '../images/frame.png', ceiling: 'high', slice: '../images/frame.png' },
      { path: '../images/frame-hover.png', ceiling: 'high', slice: '../images/frame-hover.png' },
      { path: '/static/inline.png', ceiling: 'high', slice: '/static/inline.png' },
      { path: '/static/inline@2x.png 2x', ceiling: 'high', slice: '/static/inline@2x.png 2x' },
      {
        path: '/generated/${slug}-wide.png',
        ceiling: 'medium',
        slice: '/generated/${slug}-wide.png',
      },
      { path: '/static/poster.png', ceiling: 'high', slice: '/static/poster.png' },
      { path: '/media/clip.mp4', ceiling: 'high', slice: '/media/clip.mp4' },
    ]);
  });

  it('finds nothing that a regex would have found in comments or prose', () => {
    const paths = referencesIn('Gallery.jsx').map((reference) => reference.path);

    // Each of these appears verbatim in the file, inside a comment or a string.
    expect(paths).not.toContain('./assets/retired.png');
    expect(paths).not.toContain('./assets/example.png');
    expect(paths).not.toContain('./assets/mentioned.png');
    expect(paths).not.toContain('../images/never.png');
  });

  it('ignores remote URLs and values that are not paths', () => {
    const paths = referencesIn('Gallery.jsx').map((reference) => reference.path);

    expect(paths.some((path) => path.startsWith('https://'))).toBe(false);
    // `<img src={logo} />` and `<img src={dynamic} />` are identifiers: the import
    // and the template that produced them were captured on their own.
    expect(paths).not.toContain('logo');
    expect(paths).not.toContain('dynamic');
  });
});
