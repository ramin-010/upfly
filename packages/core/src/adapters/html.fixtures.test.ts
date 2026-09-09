import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { htmlAdapter } from './html.js';

/**
 * The fixture the adapter contract asks for: a page shaped like one someone would
 * actually write, where icons, a `<picture>` block, inline CSS, comments, remote
 * URLs and escaped markup all appear together.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/html');

function referencesIn(fixture: string) {
  const file = join(FIXTURES, fixture);
  const text = readFileSync(file, 'utf8');
  return htmlAdapter.findReferences({ file, text }).map((reference) => ({
    path: reference.rawPath,
    ceiling: reference.ceiling,
    slice: text.slice(reference.start, reference.end),
  }));
}

describe('htmlAdapter fixtures', () => {
  it('reads page.html', () => {
    const references = referencesIn('page.html');

    expect(references.map((reference) => reference.path)).toEqual([
      '/favicon.png',
      '/icons/touch.png',
      '/images/hero.avif',
      // The <style> element, found via the CSS scanner.
      '/images/masthead.jpg',
      '/images/logo.svg',
      '/images/hero.avif',
      '/images/hero@2x.avif',
      '/images/hero.webp',
      '/images/hero@2x.webp',
      '/images/hero.jpg',
      '/images/hero@2x.jpg',
      // The style attribute.
      '/images/texture.png',
      '/images/poster.png',
      '/media/clip.mp4',
      // The `?v=3` sits outside the range so a rewrite preserves it.
      '/images/footer.png',
    ]);

    // Every offset points at exactly the path it claims to.
    for (const reference of references) {
      expect(reference.slice).toBe(reference.path);
      expect(reference.ceiling).toBe('high');
    }
  });

  it('ignores the stylesheet link, remote and inline images, and escaped markup', () => {
    const paths = referencesIn('page.html').map((reference) => reference.path);

    expect(paths).not.toContain('/css/site.css');
    expect(paths.some((path) => path.startsWith('https://'))).toBe(false);
    expect(paths.some((path) => path.startsWith('data:'))).toBe(false);
    expect(paths).not.toContain('escaped.png');
  });

  it('finds nothing that was commented out', () => {
    const paths = referencesIn('page.html').map((reference) => reference.path);

    expect(paths.some((path) => path.includes('old-banner'))).toBe(false);
    expect(paths.some((path) => path.includes('deleted'))).toBe(false);
  });
});
