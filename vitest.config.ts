import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Tests resolve `upfly-core` to its source, never to `packages/core/dist`. A test that
      // reached the package by name would otherwise run whatever build was made last, and
      // could pass against code that has since changed; coverage would measure the build.
      // `packages/core/test/smoke.test.ts` loads the built entry point by file path instead.
      'upfly-core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    // The tests of `bench/` and `tools/` run in the gate too. Their code measures the engine
    // and checks the gate itself: `bench/src/triage.ts` decides which unlinked hits a person
    // never sees, so a wrong verdict there would hide a false negative in the pass built to
    // find them. Coverage stays on `core`.
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/test/**/*.test.ts',
      'bench/src/**/*.test.ts',
      'tools/**/*.test.ts',
    ],
    // Vitest's defaults are 5 s per test and 10 s per hook. The suite runs its files in
    // parallel, many doing real file-system work and `sharp` encodes, so on a loaded machine
    // any test can take several times as long as it does alone, and a default limit fails a
    // tree whose every assertion passes. The limit only has to catch a hung test, which it
    // still does; speed is measured by `bench/` in CI, not here.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/core/src/**/*.ts'],
      // `.d.ts` files, `types.ts` and `index.ts` hold only types and re-exports, so counting
      // them as uncovered would be noise.
      exclude: ['**/*.test.ts', '**/*.d.ts', '**/types.ts', '**/index.ts'],
      // Core stays at 90% or above on every measure; CI's coverage job fails below it.
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
      },
    },
  },
});
