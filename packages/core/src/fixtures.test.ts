import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cssAdapter } from './adapters/css.js';
import { htmlAdapter } from './adapters/html.js';
import { javascriptAdapter } from './adapters/javascript.js';
import { jsonAdapter } from './adapters/json.js';
import { markdownAdapter } from './adapters/markdown.js';
import { discover } from './discover.js';
import { buildGraph, unreferencedAssets } from './graph.js';
import { isLinked } from './reference.js';
import { resolveReferences } from './resolve.js';
import { scanSources } from './scan.js';
import type { Adapter, Reference } from './types.js';

/**
 * The framework fixtures, exercised end to end through `discover` and the adapters.
 *
 * This is not yet the Phase 1 exit gate — that is the full validation protocol in
 * build plan §5.1, and it needs the resolver, the graph and a human. What this does
 * prove is that the trees are internally consistent, that every file an adapter
 * claims actually parses, and that no reference points at the wrong bytes.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures');

const ADAPTERS: readonly Adapter[] = [
  cssAdapter,
  htmlAdapter,
  javascriptAdapter,
  markdownAdapter,
  jsonAdapter,
];

const NAMES = ['vite-react', 'next-app', 'astro', 'plain-html', 'eleventy'] as const;

/** Where each tree serves a root-relative `/hero.png` from. */
const PUBLIC_DIRS: Record<(typeof NAMES)[number], string> = {
  'vite-react': 'public',
  'next-app': 'public',
  astro: 'public',
  // A plain static site serves from the project root itself.
  'plain-html': '',
  // Eleventy passes `src/img` through to `/img`.
  eleventy: 'src',
};

async function scan(name: string) {
  const root = join(FIXTURES, name);
  const discovered = await discover({ root, adapters: ADAPTERS });

  const scanned = await scanSources({
    sourceFiles: discovered.sourceFiles,
    adapters: ADAPTERS,
    readFile: (path) => readFile(path, 'utf8'),
  });

  // Kept separately from `scanSources`, which deliberately does not hold a whole
  // repository's source in memory. The range invariant below needs the text, and a
  // fixture tree is small enough that a test can afford it.
  const sources = new Map<string, string>();
  for (const sourceFile of discovered.sourceFiles) {
    sources.set(sourceFile.path, await readFile(sourceFile.path, 'utf8'));
  }

  return { discovered, references: scanned.references, unscanned: scanned.unscanned, sources };
}

async function resolveTree(name: (typeof NAMES)[number]): Promise<Reference[]> {
  const { discovered, references } = await scan(name);
  return resolveReferences(references, {
    root: discovered.root,
    assets: discovered.assets,
    publicDir: PUBLIC_DIRS[name],
    excludedRoots: discovered.excludedRoots,
    // The real port here: these are real trees, and a reference that would be
    // called broken deserves the one stat that proves it.
    exists: (path) => existsSync(path),
  });
}

/**
 * A filename that announces the asset is meant to have no references.
 *
 * The dead half of the §5.1(h) convention — its reference half lives in
 * `fixture-integrity.test.ts`. `removed.png` belongs here too: it is referenced
 * only from inside an HTML comment, which is precisely what that fixture tests.
 */
const DELIBERATELY_DEAD = /orphan|unused|unreferenced|never-|removed/;

describe('framework fixtures', () => {
  it.each(NAMES)('%s: discovery finds assets and source files', async (name) => {
    const { discovered } = await scan(name);

    expect(discovered.assets.length).toBeGreaterThan(0);
    expect(discovered.sourceFiles.length).toBeGreaterThan(0);
    // Nothing in a checked-in fixture should be unreadable or a symlink.
    expect(discovered.skipped).toEqual([]);
  });

  it.each(NAMES)('%s: every claimed source file parses', async (name) => {
    // An adapter throwing here would mean a fixture the engine cannot read at all,
    // which would quietly shrink what the rest of the phase is validated against.
    await expect(scan(name)).resolves.toBeDefined();
  });

  it.each(NAMES)('%s: finds references', async (name) => {
    const { references } = await scan(name);
    expect(references.length).toBeGreaterThan(0);
  });

  it.each(NAMES)('%s: every reference range selects exactly its own path', async (name) => {
    // The invariant that kills the whole class of offset bugs. §5.1(a) makes this a
    // property test over real repos too; this is the fixture half of it.
    const { references, sources } = await scan(name);

    for (const reference of references) {
      const text = sources.get(reference.file);
      expect(text).toBeDefined();
      expect(text?.slice(reference.start, reference.end)).toBe(reference.rawPath);
    }
  });

  describe('resolved against the assets that exist', () => {
    it.each(NAMES)('%s: no reference is wrongly reported broken', async (name) => {
      // The shape of the phase's exit criterion, at fixture scale. Every `broken`
      // here must be one the fixture declares in its own filename.
      const broken = (await resolveTree(name))
        .filter((reference) => reference.resolution === 'broken')
        .map((reference) => reference.rawPath);

      expect(broken.filter((path) => !path.includes('missing-on-purpose'))).toEqual([]);
    });

    it.each(NAMES)('%s: links assets', async (name) => {
      const resolved = (await resolveTree(name)).filter(isLinked);
      expect(resolved.length).toBeGreaterThan(0);
    });

    it('keeps the one deliberately broken reference, so the check has teeth', async () => {
      const broken = (await resolveTree('plain-html')).filter(
        (reference) => reference.resolution === 'broken',
      );
      expect(broken.map((reference) => reference.rawPath)).toEqual([
        'images/missing-on-purpose.png',
      ]);
    });

    it('reports a templated eleventy path as dynamic rather than broken', async () => {
      const dynamic = (await resolveTree('eleventy')).filter(
        (reference) => reference.resolution === 'dynamic',
      );
      expect(dynamic.map((reference) => reference.rawPath)).toEqual([
        '{{ site.url }}/img/templated.png',
      ]);
    });

    it('drops non-asset references rather than reporting them', async () => {
      // vite-react references `.css`, `.jsx` and `.svg`; only the svg is tracked.
      const { references } = await scan('vite-react');
      const resolved = await resolveTree('vite-react');
      expect(resolved.length).toBeLessThan(references.length);
      expect(resolved.every((reference) => reference.rawPath.includes('.css'))).toBe(false);
    });
  });

  describe('linked into a graph', () => {
    async function graphTree(name: (typeof NAMES)[number]) {
      const { discovered, unscanned } = await scan(name);
      return buildGraph({
        root: discovered.root,
        assets: discovered.assets,
        references: await resolveTree(name),
        // Both sources, always. Discovery's unclaimed extensions and scan's parse
        // failures are one condition to the audit: we did not read that file.
        unscannedFiles: [...discovered.unscannedFiles, ...unscanned],
      });
    }

    it.each(NAMES)('%s: every asset becomes a node and no reference is lost', async (name) => {
      const { discovered } = await scan(name);
      const graph = await graphTree(name);
      const resolved = await resolveTree(name);

      expect(graph.assets).toHaveLength(discovered.assets.length);
      expect(graph.references).toHaveLength(resolved.length);
      // Rule 9 at the layer most likely to lose one: every reference is in exactly
      // one bucket, so it cannot vanish from the report without vanishing here.
      expect(Object.values(graph.byResolution).flat()).toHaveLength(resolved.length);
    });

    it.each(NAMES)(
      '%s: every unreferenced asset is declared dead or named in a file we could not read',
      async (name) => {
        // The R8 mechanism at fixture scale, before the audit that will implement
        // it exists. An asset with zero references is either deliberate — the
        // fixture says so in its filename, per §5.1(h) — or it is mentioned in a
        // file no adapter read, which is what makes it `possibly-dead` rather than
        // a false `dead` finding we manufactured ourselves.
        const graph = await graphTree(name);
        const mentioned = new Set<string>();
        const haystack = [
          ...(await Promise.all(graph.unscannedFiles.map((file) => readFile(file.path, 'utf8')))),
          // The second half, found by this very test on the eleventy tree and
          // raised as R10: a reference we *read* but could not resolve names no
          // asset, so an asset it may point at looks dead. `templated.png` is
          // referenced by `![](({{ site.url }}/img/templated.png)` in a file we
          // parsed perfectly — it is `dynamic`, not missing, and reporting it dead
          // is the same manufactured false positive from the other direction.
          ...graph.byResolution.dynamic.map((reference) => reference.rawPath),
          ...graph.byResolution['unresolved-alias'].map((reference) => reference.rawPath),
          ...graph.byResolution.discarded.map((reference) => reference.rawPath),
        ];

        for (const text of haystack) {
          for (const node of graph.assets) {
            if (text.includes(basename(node.asset.relative))) {
              mentioned.add(node.asset.relative);
            }
          }
        }

        const unexplained = unreferencedAssets(graph)
          .map((node) => node.asset.relative)
          .filter((relative) => !DELIBERATELY_DEAD.test(relative) && !mentioned.has(relative));

        expect(unexplained).toEqual([]);
      },
    );

    it('rescues three astro assets that only index.astro references', async () => {
      // The gap made concrete. `.astro` is unclaimed, so `logo.png` (an import),
      // `favicon.png` (a `<link rel=icon>`) and `banner.png` (an `<img src>`) all
      // have zero references for a reason that has nothing to do with the assets.
      const graph = await graphTree('astro');

      expect(graph.unscannedExtensions).toEqual([{ ext: '.astro', fileCount: 1 }]);
      expect(unreferencedAssets(graph).map((node) => node.asset.relative)).toEqual([
        'public/banner.png',
        'public/favicon.png',
        'public/never-used.png',
        'src/assets/logo.png',
      ]);
    });

    it('reports two eleventy templates as unread', async () => {
      const graph = await graphTree('eleventy');

      expect(graph.unscannedExtensions).toEqual([{ ext: '.njk', fileCount: 2 }]);
    });

    it('counts an SVG as unread even though it is also an asset', async () => {
      // An SVG can carry `<image href="hero.png">`, and no adapter reads one. It is
      // both an asset and a file we did not scan.
      const graph = await graphTree('vite-react');

      expect(graph.unscannedExtensions).toEqual([{ ext: '.svg', fileCount: 1 }]);
      expect(graph.assets.some((node) => node.asset.relative.endsWith('.svg'))).toBe(true);
    });

    it.each(['next-app', 'plain-html'] as const)(
      '%s: was read completely, so a dead finding needs no hedge',
      async (name) => {
        // The case the amended rule reserves `dead` for. Rare in the wild, which is
        // why hedging had to become per-asset rather than global — but it exists,
        // and both branches are reachable at fixture scale.
        expect((await graphTree(name)).unscannedExtensions).toEqual([]);
      },
    );

    it('links a CSS-only reference, so the asset is not dead', async () => {
      // `unused-in-css.png` is named for the trap: unused in JSX, referenced from a
      // stylesheet. An engine that only read components would call it dead.
      const graph = await graphTree('vite-react');
      const node = graph.assets.find((entry) => entry.asset.relative.endsWith('unused-in-css.png'));

      expect(node?.references.length).toBeGreaterThan(0);
    });
  });

  it('covers the adapters the compatibility matrix claims', async () => {
    const seen = new Set<string>();
    for (const name of NAMES) {
      const { discovered } = await scan(name);
      for (const sourceFile of discovered.sourceFiles) seen.add(sourceFile.adapterId);
    }

    expect([...seen].sort()).toEqual(['css', 'html', 'javascript', 'json', 'markdown']);
  });

  it('leaves .astro and .njk unclaimed, which is the known gap', async () => {
    // No adapter handles these yet — they are the empty cells in the compatibility
    // matrix and the intended first community contributions (§1.5, §5 Phase 5).
    const { discovered } = await scan('astro');
    const claimed = discovered.sourceFiles.map((file) => file.relative);

    expect(claimed.some((relative) => relative.endsWith('.astro'))).toBe(false);
  });
});
