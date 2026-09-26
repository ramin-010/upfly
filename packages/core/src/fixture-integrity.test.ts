import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defaultAdapters } from './adapters/default-adapters.js';
import { discover } from './discover.js';
import { extensionOf, isImageExtension } from './paths.js';
import type { Adapter } from './types.js';

/**
 * Every reference in a fixture either resolves to a real file or is named to declare
 * itself deliberate.
 *
 * Adapters never touch a disk, so at their layer a reference to nothing looks like a good
 * one. This test checks the fixtures against the filesystem with its own resolution
 * rather than the engine's resolver, so a resolver bug cannot hide a fixture defect, or
 * the other way round: if the two disagree, one of them is wrong.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures');

const ADAPTERS: readonly Adapter[] = defaultAdapters;

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
  // A hand-built tree for the planner's partial states, such as a pattern where only
  // some matching files convert. It has no build, so it is in neither `fixtures.test.ts`
  // nor `bench/src/fixture-build.ts`. It is checked here because a reference in it that
  // stopped resolving would remove the partial state while the planner's tests passed.
  { name: 'partial-pattern', publicDir: 'public' },
];

/**
 * A filename that announces it is meant to point at nothing.
 *
 * A deliberate dangling reference has to say so in its own name, or it cannot be told
 * apart from the accident this test exists to catch.
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

      // A module specifier such as `react` or `next/image` has no extension, and resolving
      // one is Node's module resolution, which this check does not do.
      //
      // The whitespace and comma test keeps that exemption narrow. An unsplit JSX `srcSet`
      // (`/a.jpg 1x, /b.jpg 2x`) also ends without an extension, and skipping it would hide
      // an adapter that failed to split it: it is never a module specifier, so it is
      // checked, and fails.
      const looksLikeModuleSpecifier =
        !/\.[a-z0-9]+$/i.test(reference.rawPath) && !/[\s,]/.test(reference.rawPath);
      if (looksLikeModuleSpecifier) continue;

      // A speculative string that does not name an image is not a reference to anything
      // in this tree, and the engine does not check one either: the resolver drops an
      // untracked extension before it asks the filesystem. A version range such as
      // `"^19.0.0"` in a fixture's `package.json` ends in `.0`, passes the extension test
      // above, and reaches here as a speculative path. `asserted` references are still
      // checked whatever their extension, and so is a speculative `.png`.
      if (!reference.asserted && !isImageExtension(extensionOf(reference.rawPath))) continue;

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

  // A root-relative path may be served from the public directory or from the project
  // root. Vite does both, which is how `/src/main.jsx` works in an index.html that also
  // references `/screenshot.png`.
  const candidates = [join(root, rawPath)];
  if (publicDir !== null) candidates.push(join(root, publicDir, rawPath));
  return candidates.some((candidate) => existsSync(candidate));
}

describe('fixture integrity', () => {
  it.each(TREES.map((tree) => tree.name))(
    '%s: every reference resolves, or declares itself deliberate',
    async (name) => {
      const tree = TREES.find((candidate) => candidate.name === name);
      expect(tree).toBeDefined();
      if (tree === undefined) return;

      const unresolved = await unresolvedIn(tree);
      const accidental = unresolved.filter((entry) => !DELIBERATE.test(entry.rawPath));

      // Each entry names its file, so a failure prints which reference in which file is wrong.
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
    // `fixtures/upfly.config.json` turns off the v2 VS Code extension, which converts
    // images in place; this checks that it stayed off.
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
        // One exception, and its name declares it, like `missing-on-purpose.png`:
        // `theme-not-an-image.png` is an HTML error page with a `.png` name, the file that
        // blocks the pattern in `fixtures/partial-pattern`, and it probes as `not-an-image`.
        // It is matched by name rather than by a count of failures, so a converted fixture
        // still fails here.
        if (asset.relative.endsWith('/theme-not-an-image.png')) continue;

        const bytes = await readFile(asset.path);
        expect([...bytes.subarray(0, signature[1].length)]).toEqual([...signature[1]]);
      }
    }
  });
});
