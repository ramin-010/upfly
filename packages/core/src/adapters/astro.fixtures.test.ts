import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { astroAdapter } from './astro.js';

/**
 * The fixture the adapter rules ask for, shaped like a component someone would write:
 * imports in the fence, plain `<img src>` and a `<link href>` in the body, a `<style>`
 * block, a templated path, component bindings, and commented-out paths. See "Adapters:
 * the contribution surface" in ARCHITECTURE.md.
 *
 * Every expected value here is written from reading the fixture, never from running the
 * adapter and pasting its output: an assertion whose expected value came from the code
 * cannot vouch for the code.
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
      // `astro:assets` is absent, and correctly: it is a virtual module, and `astro:`
      // matches the URL-scheme test in `reference-path.ts`, so it is dropped as an
      // external URL rather than carried as a path.
      '~/assets/houston.png',
      './sidebar.webp',
      '~/components/Button.astro',
      'gallery/one.png',
      'gallery/two.png',
      // --- the body, read as HTML ---
      '/favicon.png',
      // `{Houston}` and `{local}` yield nothing: a braced value is read as JavaScript,
      // and an identifier is a value, not a path. Their fence imports are the references.
      '/banner.png',
      './relative.png',
      // Read by the JavaScript adapter, so the path is the template's own text rather
      // than the whole `{…}` with its braces and backticks.
      '/gallery/${gallery[0]}.png',
      '/nested/icon.png',
      // The <style> block, reached through the CSS adapter.
      '/texture.png',
    ]);
  });

  it('keeps every offset pointing at the real file, across both halves', () => {
    // An off-by-one here corrupts a source file at rewrite time rather than merely
    // reporting something wrong. Blanking the other half, rather than slicing it out, is
    // what keeps every offset exact, and this proves it.
    const { text, references } = referencesIn('Page.astro');

    for (const reference of references) {
      expect(text.slice(reference.start, reference.end)).toBe(reference.rawPath);
    }
  });

  it('gives a fence import the ceiling an import deserves', () => {
    const { references } = referencesIn('Page.astro');
    const houston = references.find((reference) => reference.rawPath === '~/assets/houston.png');

    // An ESM import specifier cannot be anything but a module path, so it is `certain`,
    // and an asset imported in a fence is an ordinary link.
    expect(houston?.ceiling).toBe('certain');
    expect(houston?.asserted).toBe(true);
    expect(houston?.kind).toBe('import');
  });

  it('never lets a templated body path claim to be static', () => {
    const { references } = referencesIn('Page.astro');
    const templated = references.find((reference) => reference.rawPath.includes('${'));

    // A templated path reported as broken would be a false positive. This one has one
    // unknown segment in the name, so it globs at `medium`, and the resolver never lets a
    // pattern fall through to `broken`: it links every match or says `dynamic`.
    expect(templated?.ceiling).toBe('medium');
    expect(templated?.shape).toBe('js.template.pattern');
  });

  it('finds nothing in a commented-out path', () => {
    const { references } = referencesIn('Page.astro');
    const paths = references.map((reference) => reference.rawPath);

    // One is inside a `//` comment in the fence, one inside an HTML comment in the
    // body: the two halves' comment syntaxes, which is why both are here.
    expect(paths).not.toContain('./commented.png');
    expect(paths).not.toContain('./ignored.png');
  });

  it('reads a component with no frontmatter fence at all', () => {
    // A missing fence is ordinary, not a parse failure: astro-docs has components with
    // none. Treating it as one would turn each of them into a silent coverage gap.
    const { text, references } = referencesIn('NoFence.astro');

    expect(references.map((reference) => reference.rawPath)).toEqual(['/no-fence.png']);
    expect(text.slice(references[0]?.start ?? 0, references[0]?.end ?? 0)).toBe('/no-fence.png');
  });
});
