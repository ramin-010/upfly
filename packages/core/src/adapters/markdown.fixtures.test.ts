import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { jsonAdapter } from './json.js';
import { markdownAdapter } from './markdown.js';

/**
 * Fixtures for the two regex-based adapters, in the shape of files people write:
 * a README whose fenced examples and HTML comments are full of paths that must not
 * be touched, and a web app manifest whose values are all speculative candidates.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures');

function referencesIn(adapter: typeof markdownAdapter, relative: string) {
  const file = join(FIXTURES, relative);
  const text = readFileSync(file, 'utf8');
  return adapter.findReferences({ file, text }).map((reference) => ({
    path: reference.rawPath,
    ceiling: reference.ceiling,
    asserted: reference.asserted,
    slice: text.slice(reference.start, reference.end),
  }));
}

describe('markdownAdapter fixtures', () => {
  const references = () => referencesIn(markdownAdapter, 'markdown/README.md');

  it('reads README.md', () => {
    expect(references().map((reference) => reference.path)).toEqual([
      './docs/badge.svg',
      './docs/hero.png',
      './docs/screen.avif',
      './docs/screen@2x.avif',
      './docs/screen.png',
      './docs/architecture.png',
      '{{ site.baseurl }}/images/logo.png',
      './docs/sponsor.png',
    ]);
  });

  it('points every reference at exactly its own path text', () => {
    for (const reference of references()) {
      expect(reference.slice).toBe(reference.path);
    }
  });

  it('finds nothing inside a fence, a code span or an HTML comment', () => {
    const paths = references().map((reference) => reference.path);

    for (const trap of [
      'not-a-reference',
      'example-only',
      'also-example-only',
      'code-example',
      'old-banner',
      'old-inline',
    ]) {
      expect(paths.some((path) => path.includes(trap))).toBe(false);
    }
  });

  it('reports the templated path as unsafe rather than broken or missing', () => {
    const templated = references().find((reference) => reference.path.includes('{{'));
    expect(templated?.ceiling).toBe('unsafe');
  });

  it('ignores the remote reference definition', () => {
    expect(references().some((reference) => reference.path.startsWith('https://'))).toBe(false);
  });
});

describe('jsonAdapter fixtures', () => {
  const references = () => referencesIn(jsonAdapter, 'json/site.webmanifest.json');

  it('reads site.webmanifest.json', () => {
    expect(references().map((reference) => reference.path)).toEqual([
      // A version string looks path-shaped. Deliberate: the resolver discards it,
      // and being stingy here is what loses real references.
      '2.4.1',
      '/icons/icon-192.png',
      '/icons/icon-512.png',
      '/icons/maskable.png',
      './screenshots/wide.webp',
      '/icons/inbox.svg',
      'README.md',
    ]);
  });

  it('marks every candidate speculative, so none can become a broken finding', () => {
    expect(references().every((reference) => reference.asserted === false)).toBe(true);
  });

  it('skips keys, remote URLs and data URIs', () => {
    const paths = references().map((reference) => reference.path);

    expect(paths.some((path) => path.includes('a-key-that-looks-like-a-path'))).toBe(false);
    expect(paths.some((path) => path.startsWith('https://'))).toBe(false);
    expect(paths.some((path) => path.startsWith('data:'))).toBe(false);
  });

  it('points every candidate at exactly its own path text', () => {
    for (const reference of references()) {
      expect(reference.slice).toBe(reference.path);
    }
  });
});
