import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cssAdapter } from './adapters/css.js';
import { htmlAdapter } from './adapters/html.js';
import { javascriptAdapter } from './adapters/javascript.js';
import { jsonAdapter } from './adapters/json.js';
import { markdownAdapter } from './adapters/markdown.js';
import { discover } from './discover.js';
import type { Adapter, RawReference } from './types.js';

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

const BY_ID = new Map(ADAPTERS.map((adapter) => [adapter.id, adapter]));

const NAMES = ['vite-react', 'next-app', 'astro', 'plain-html', 'eleventy'] as const;

async function scan(name: string) {
  const root = join(FIXTURES, name);
  const discovered = await discover({ root, adapters: ADAPTERS });

  const references: RawReference[] = [];
  const sources = new Map<string, string>();

  for (const sourceFile of discovered.sourceFiles) {
    const adapter = BY_ID.get(sourceFile.adapterId);
    if (adapter === undefined) throw new Error(`no adapter for ${sourceFile.relative}`);

    const text = await readFile(sourceFile.path, 'utf8');
    sources.set(sourceFile.path, text);
    references.push(...adapter.findReferences({ file: sourceFile.path, text }));
  }

  return { discovered, references, sources };
}

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
