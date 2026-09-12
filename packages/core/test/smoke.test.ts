import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The one test that runs the PUBLISHED artefact rather than the source.
 *
 * Every other test resolves `upfly-core` to `packages/core/src` through the alias in
 * `vitest.config.ts`, which is what stops a stale build being silently validated. The
 * cost of that alias is that nothing else would ever load `dist`, so nothing would
 * exercise the `exports` map, the emitted JavaScript, or the fact that the package
 * resolves at all for somebody who installed it.
 *
 * That gap has been paid for before. The previous generation of this project shipped a
 * VS Code extension that worked only on Windows for months, because every test ran
 * against source and nothing ever imported what was actually packaged.
 *
 * So this file imports the built entry point by path, deliberately escaping the alias,
 * and asserts the compiled code runs rather than merely resolving.
 */

const BUILT_ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url));

/**
 * Fail with an instruction rather than a module-resolution stack trace.
 *
 * A missing `dist` is a forgotten `pnpm build`, and a developer meeting that deserves
 * to be told so. It deliberately fails rather than skipping: a smoke test that quietly
 * does nothing when the artefact is absent is exactly the shape that let the packaged
 * output go untested in the first place.
 */
async function loadBuiltPackage(): Promise<Record<string, unknown>> {
  if (!existsSync(BUILT_ENTRY)) {
    throw new Error(
      'packages/core/dist is not built, so the packaged artefact cannot be tested. Run `pnpm build` (or `pnpm typecheck`, which builds) and try again. This test is the only one that loads dist; every other test runs source through the vitest alias.',
    );
  }
  return (await import(BUILT_ENTRY)) as Record<string, unknown>;
}

describe('the built package', () => {
  it('resolves and loads through its own entry point', async () => {
    const built = await loadBuiltPackage();

    expect(typeof built).toBe('object');
  });

  it('exports the functions the CLI and the extension import by name', async () => {
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
      expect(typeof built[name], `${name} is missing from the built entry point`).toBe('function');
    }
  });

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
