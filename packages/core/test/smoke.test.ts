import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The one test that loads the built package rather than the source.
 *
 * Every other test resolves `upfly-core` to `packages/core/src` through the alias in
 * `vitest.config.ts`, so a stale build is never what gets tested, and nothing else loads
 * `dist`. This file imports the built entry point by file path, outside the alias, and
 * checks that the compiled code runs, not only that it resolves. A path import does not
 * read the `exports` map, so the map itself is not tested here.
 */

const BUILT_ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url));

/**
 * Fail with an instruction rather than a module-resolution stack trace.
 *
 * A missing `dist` is a forgotten `pnpm build`. It fails rather than skips: a smoke test
 * that passes when the artefact is absent tests nothing.
 */
async function loadBuiltPackage(): Promise<Record<string, unknown>> {
  if (!existsSync(BUILT_ENTRY)) {
    throw new Error(
      'packages/core/dist is not built, so the packaged artefact cannot be tested. Run `pnpm build` (or `pnpm typecheck`, which builds) and try again. This test is the only one that loads dist; every other test runs source through the vitest alias.',
    );
  }
  return (await import(BUILT_ENTRY)) as Record<string, unknown>;
}

/**
 * Long enough that the clock is never what fails, because the clock asserts nothing.
 *
 * Loading `dist` is real filesystem work and runs alongside the rest of the suite: about
 * 440 ms alone, but past vitest's 5 second default inside the full suite, where a failure
 * would track how many other tests happen to be running rather than anything about the
 * package. An import that takes thirty seconds still fails.
 */
const LOAD_TIMEOUT_MS = 30_000;

describe('the built package', () => {
  it(
    'resolves and loads through its own entry point',
    async () => {
      const built = await loadBuiltPackage();

      expect(typeof built).toBe('object');
    },
    LOAD_TIMEOUT_MS,
  );

  // The same timeout, for the same reason. Without it this test passes only because the
  // test above has already cached the module, which is an accident of ordering.
  it(
    'exports the functions the CLI and the extension import by name',
    async () => {
      const built = await loadBuiltPackage();

      // A representative slice across the modules an outside caller actually reaches:
      // discovery, planning, the transaction, the report and the probe. A name missing
      // here means the emitted entry point does not match the source's public surface.
      for (const name of [
        'discover',
        'planOptimization',
        'buildReport',
        'renderReport',
        'optimize',
        'prepare',
        'commit',
        'probeAssets',
        'createSharpProbe',
        'parseManifest',
        'serialiseManifest',
      ]) {
        expect(typeof built[name], `${name} is missing from the built entry point`).toBe(
          'function',
        );
      }
    },
    LOAD_TIMEOUT_MS,
  );

  it('exports the adapter set, which is a value rather than a function', async () => {
    const built = await loadBuiltPackage();
    const adapters = built.defaultAdapters as readonly {
      readonly id: string;
      readonly extensions: readonly string[];
      readonly findReferences: unknown;
    }[];

    // Separate from the functions above because it is the contribution surface: an
    // adapter list that survived compilation empty, or whose entries lost a method,
    // would leave every reference unscanned and every finding absent, which reads as
    // a clean repository rather than as a broken build.
    expect(Array.isArray(adapters)).toBe(true);
    expect(adapters.length).toBeGreaterThan(0);
    for (const adapter of adapters) {
      expect(typeof adapter.id, 'an adapter lost its id').toBe('string');
      expect(adapter.extensions.length, `${adapter.id} handles no extensions`).toBeGreaterThan(0);
      expect(typeof adapter.findReferences, `${adapter.id} cannot scan`).toBe('function');
    }
  });

  it('runs compiled code, not just resolves it', async () => {
    const built = await loadBuiltPackage();
    const isExternalUrl = built.isExternalUrl as (path: string) => boolean;

    // A pure function with no dependencies, so a failure here is the build being
    // wrong rather than an environment being unusual.
    expect(isExternalUrl('https://example.com/hero.png')).toBe(true);
    expect(isExternalUrl('./hero.png')).toBe(false);
  });

  it('serialises a manifest through the built code, which is the format on disk', async () => {
    const built = await loadBuiltPackage();
    const serialise = built.serialiseManifest as (manifest: unknown) => string;
    const parse = built.parseManifest as (text: string) => unknown;
    const version = built.MANIFEST_SCHEMA_VERSION as number;

    // The manifest is a published format that outlives the run that wrote it, so a
    // build whose emitted code round-trips it wrongly is a data-loss bug rather than
    // a cosmetic one.
    const manifest = {
      schemaVersion: version,
      hashAlgorithm: 'sha256',
      runId: '20260912T000000-0000',
      startedAt: '2026-09-12T00:00:00.000Z',
      state: 'committed',
      operations: [],
      declined: [],
    };

    expect(parse(serialise(manifest))).toEqual(manifest);
  });
});
