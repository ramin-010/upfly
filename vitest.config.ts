import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Tests resolve `upfly-core` to source, never to the compiled output.
      //
      // Without this, any test whose import chain reaches the package by name runs
      // whatever happens to be in `packages/core/dist`, which is a build from some
      // earlier moment. That was not hypothetical: a wiring test was found validating
      // a core compiled forty-six minutes before the source it was meant to be
      // checking, and it passed, because the behaviour it asserts had not changed in
      // those forty-six minutes. A test that passes for a reason other than the code
      // being right is this project's dominant defect class, and a stale artefact
      // makes it silent.
      //
      // The alias makes that unrepresentable rather than something each chat has to
      // remember to rebuild. It also stops coverage measuring compiled output, which
      // it was doing for anything reached this way.
      //
      // `smoke.test.ts` deliberately escapes it by importing the built file by path,
      // because after this alias nothing else would exercise the exports map.
      'upfly-core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    // `bench/` is included because `triage.ts` decides which §5.1(b) hits a person
    // never sees. A wrong 'explained' there hides a false negative inside the pass
    // built to find false negatives, which is the one outcome nothing downstream
    // looks at again. Coverage stays scoped to `core` below.
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/test/**/*.test.ts',
      'bench/src/**/*.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/core/src/**/*.ts'],
      // `.d.ts` files hold no runtime code; counting them as 0% covered is noise.
      exclude: ['**/*.test.ts', '**/*.d.ts', '**/types.ts', '**/index.ts'],
      // Rule 3 of the engineering constraints: 90% on core, enforced in CI.
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
      },
    },
  },
});
