import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { astroAdapter } from './astro.js';

/**
 * The fixture the adapter contract asks for, shaped like a component someone would
 * write: imports in the fence, plain `<img src>` and a `<link href>` in the body,
 * a `<style>` block, a templated path, component bindings, and commented-out paths.
 *
 * Every expected value here is written from reading the fixture, never from running
 * the adapter and pasting its output — an assertion whose expected value came from
 * the code cannot vouch for the code.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/astro');

function referencesIn(fixture: string) {
  const file = join(FIXTURES, fixture);
  const text = readFileSync(file, 'utf8');
  return {
    text,
    references: astroAdapter.findReferences({ file, text }),
  };
}

describe('astroAdapter fixtures', () => {
  it('reads both halves of Page.astro, in file order', () => {
    const { references } = referencesIn('Page.astro');

    expect(references.map((reference) => reference.rawPath)).toEqual([
      // --- the frontmatter fence, read as TypeScript ---
      //
      // `astro:assets` is deliberately absent. It is a virtual module, and `astro:`
      // matches the URL-scheme test in `reference-path.ts`, so it is excluded as an
      // external URL rather than carried as a path. This expectation was written the
      // other way from reading the fixture, and the engine was right — recorded so
      // nobody "fixes" it back.
      '~/assets/houston.png',
      './sidebar.webp',
      '~/components/Button.astro',
      'gallery/one.png',
      'gallery/two.png',
      // --- the body, read as HTML ---
      '/favicon.png',
      '{Houston}',
      '{local}',
      '/banner.png',
      './relative.png',
      '{`/gallery/${gallery[0]}.png`}',
      '/nested/icon.png',
      // The <style> block, reached through the CSS adapter.
      '/texture.png',
    ]);
  });

  it('keeps every offset pointing at the real file, across both halves', () => {
    // The invariant that matters most for Phase 2: an off-by-one here corrupts a
    // source file at rewrite time rather than merely reporting something wrong. The
    // masking approach is what earns it, and this is what proves it.
    const { text, references } = referencesIn('Page.astro');

    for (const reference of references) {
      expect(text.slice(reference.start, reference.end)).toBe(reference.rawPath);
    }
  });

  it('gives a fence import the ceiling an import deserves', () => {
    const { references } = referencesIn('Page.astro');
    const houston = references.find((reference) => reference.rawPath === '~/assets/houston.png');

    // `certain` — an ESM import specifier cannot be anything but a module path, and
    // this is what makes the nine hedged astro-docs assets ordinary links.
    expect(houston?.ceiling).toBe('certain');
    expect(houston?.asserted).toBe(true);
    expect(houston?.kind).toBe('import');
  });

  it('never lets a templated body path claim to be static', () => {
    const { references } = referencesIn('Page.astro');
    const templated = references.find((reference) => reference.rawPath.includes('${'));

    // `unsafe` sends it to `dynamic` rather than to `broken`. Reporting a templated
    // path as a broken reference is the false positive the exit criterion forbids.
    expect(templated?.ceiling).toBe('unsafe');
  });

  it('finds nothing in a commented-out path', () => {
    const { references } = referencesIn('Page.astro');
    const paths = references.map((reference) => reference.rawPath);

    // One is inside a `//` comment in the fence, one inside an HTML comment in the
    // body — the two halves' comment syntaxes, which is why both are here.
    expect(paths).not.toContain('./commented.png');
    expect(paths).not.toContain('./ignored.png');
  });

  it('reads a component with no frontmatter fence at all', () => {
    // A missing fence is ordinary, not a parse failure. Treating it as one would
    // turn six of astro-docs' 86 components into a silent coverage gap.
    const { text, references } = referencesIn('NoFence.astro');

    expect(references.map((reference) => reference.rawPath)).toEqual(['/no-fence.png']);
    expect(text.slice(references[0]?.start ?? 0, references[0]?.end ?? 0)).toBe('/no-fence.png');
  });
});
