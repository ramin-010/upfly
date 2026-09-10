import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cssAdapter } from './adapters/css.js';
import { htmlAdapter } from './adapters/html.js';
import { javascriptAdapter } from './adapters/javascript.js';
import { jsonAdapter } from './adapters/json.js';
import { markdownAdapter } from './adapters/markdown.js';
import { discover } from './discover.js';
import type { Adapter } from './types.js';

/**
 * Build plan §5.1(h): every reference in a fixture either resolves to a real file,
 * or is named to declare itself deliberate.
 *
 * This exists because the fixtures were committed with 17 references pointing at
 * nothing, and nothing caught it. It was invisible from where the other tests stand:
 * `fixtures.test.ts` hands source text to adapters, and an adapter never touches a
 * disk by design, so at that layer a reference to nothing looks exactly like a good
 * one. A test can only vouch for what its layer can see, so this is the layer that
 * sees the filesystem.
 *
 * Resolution here is deliberately **not** the engine's resolver. An independent
 * oracle means a resolver bug cannot hide a fixture defect, and vice versa — if the
 * two ever disagree, one of them is wrong and we want to be told.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures');

const ADAPTERS: readonly Adapter[] = [
  cssAdapter,
  htmlAdapter,
  javascriptAdapter,
  markdownAdapter,
  jsonAdapter,
];

const BY_ID = new Map(ADAPTERS.map((adapter) => [adapter.id, adapter]));

interface Tree {
  readonly name: string;
  /** Where a root-relative `/x.png` is served from, relative to the tree root. */
  readonly publicDir: string | null;
}

const TREES: readonly Tree[] = [
  { name: 'vite-react', publicDir: 'public' },
  { name: 'next-app', publicDir: 'public' },
  { name: 'astro', publicDir: 'public' },
  { name: 'plain-html', publicDir: null },
  // Eleventy copies `src/img` through to `/img`, so `src` is what serves a
  // root-relative path.
  { name: 'eleventy', publicDir: 'src' },
];

/**
 * A filename that announces it is meant to point at nothing.
 *
 * Keeping the convention explicit is the other half of §5.1(h): a deliberate
 * dangling reference has to say so in its own name, or it is indistinguishable from
 * the accident this test exists to catch.
 */
const DELIBERATE = /missing-on-purpose|does-not-exist/;

interface Unresolved {
  readonly from: string;
  readonly rawPath: string;
}

async function unresolvedIn(tree: Tree): Promise<Unresolved[]> {
  const root = join(FIXTURES, tree.name);
  const discovered = await discover({ root, adapters: ADAPTERS });
  const unresolved: Unresolved[] = [];

  for (const sourceFile of discovered.sourceFiles) {
    const adapter = BY_ID.get(sourceFile.adapterId);
    if (adapter === undefined) continue;

    const text = await readFile(sourceFile.path, 'utf8');
    for (const reference of adapter.findReferences({ file: sourceFile.path, text })) {
      // A path that was never static cannot be checked against a filesystem.
      if (reference.ceiling === 'unsafe' || reference.ceiling === 'medium') continue;

      // A module specifier — `react`, `next/image` — has no extension, and
      // resolving those is node resolution rather than Phase 1's job.
      //
      // The whitespace and comma test is what stops this exemption from becoming a
      // hole. An unsplit JSX `srcSet` ("/a.jpg 1x, /b.jpg 2x") also ends without an
      // extension, and skipping it hid a real adapter bug behind a green test: it is
      // never a module specifier, so it must be checked and must fail.
      const looksLikeModuleSpecifier =
        !/\.[a-z0-9]+$/i.test(reference.rawPath) && !/[\s,]/.test(reference.rawPath);
      if (looksLikeModuleSpecifier) continue;

      if (!resolvesOnDisk(reference.rawPath, sourceFile.path, root, tree.publicDir)) {
        unresolved.push({ from: sourceFile.relative, rawPath: reference.rawPath });
      }
    }
  }

  return unresolved;
}

function resolvesOnDisk(
  rawPath: string,
  fromFile: string,
  root: string,
  publicDir: string | null,
): boolean {
  if (!rawPath.startsWith('/')) {
    return existsSync(resolve(dirname(fromFile), rawPath));
  }

  // A root-relative path may be served from the public directory or from the
  // project root — Vite does both, which is how `/src/main.jsx` works in an
  // index.html that also references `/screenshot.png`.
  const candidates = [join(root, rawPath)];
  if (publicDir !== null) candidates.push(join(root, publicDir, rawPath));
  return candidates.some((candidate) => existsSync(candidate));
}

describe('fixture integrity (build plan §5.1h)', () => {
  it.each(TREES.map((tree) => tree.name))(
    '%s: every reference resolves, or declares itself deliberate',
    async (name) => {
      const tree = TREES.find((candidate) => candidate.name === name);
      expect(tree).toBeDefined();
      if (tree === undefined) return;

      const unresolved = await unresolvedIn(tree);
      const accidental = unresolved.filter((entry) => !DELIBERATE.test(entry.rawPath));

      // Named so a failure prints exactly which reference in which file is wrong.
      expect(accidental).toEqual([]);
    },
  );

  it('keeps at least one deliberately dangling reference, so the check has teeth', async () => {
    const plainHtml = TREES.find((tree) => tree.name === 'plain-html');
    expect(plainHtml).toBeDefined();
    if (plainHtml === undefined) return;

    const unresolved = await unresolvedIn(plainHtml);
    expect(unresolved.map((entry) => entry.rawPath)).toEqual(['images/missing-on-purpose.png']);
  });

  it('every fixture image is the format its extension claims', async () => {
    // The v2 extension converted 26 of these to WebP in place and deleted the
    // originals, which is what produced the 17 dangling references in the first
    // place. `fixtures/upfly.config.json` disables it; this asserts it stayed off.
    const signatures: ReadonlyArray<[extension: string, magic: readonly number[]]> = [
      ['.png', [0x89, 0x50, 0x4e, 0x47]],
      ['.jpg', [0xff, 0xd8]],
    ];

    for (const tree of TREES) {
      const root = join(FIXTURES, tree.name);
      const { assets } = await discover({ root, adapters: ADAPTERS });

      for (const asset of assets) {
        const signature = signatures.find(([extension]) => asset.extension === extension);
        if (signature === undefined) continue;

        const bytes = await readFile(asset.path);
        expect([...bytes.subarray(0, signature[1].length)]).toEqual([...signature[1]]);
      }
    }
  });
});
