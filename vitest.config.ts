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
      'tools/**/*.test.ts',
    ],
    // 🔴 **Vitest defaults to 5,000 ms per test and 10,000 ms per hook, and both have now
    // produced a FALSE DENY on a tree whose every assertion passes (R163).** CLAUDE.md
    // names that as the failure mode to watch — a gate that refuses a commit it had no
    // business refusing trains `[wip]`, and once `[wip]` is reflex the gate is dead while
    // the suite still looks protected. It has now happened twice: R162's commit was marked
    // `[wip]` over exactly this.
    //
    // ⚠️ **The measurement says the cause is the SUITE, not any one test, and that is why
    // this is here rather than on the tests that happened to flake.** B11 hit a different
    // shape and fixed it correctly per-test: `generate.test.ts` and `root-inference.test.ts`
    // genuinely cost ~4,700 ms and sat at 94% of the budget, so a nudge tipped them. The two
    // that flaked here are not near the budget at all — `report.test.ts`'s R131/R139 case
    // costs **498 ms alone and 2,058 ms inside the full 59-file run (4.1x)**, and on the
    // parent chat's machine the same test crossed 5,000 ms, which is upward of 10x. What
    // moves is the contention: 59 files in parallel, each doing real filesystem work and
    // real `sharp` encodes, on a machine R124 measured at 39–63% background load. **Any
    // test in this suite is exposed to that multiplier**, so raising the budget only on the
    // ones that have flaked so far is whack-a-mole that re-runs this investigation every
    // time a different one draws the short straw.
    //
    // ✅ **No signal is lost by being generous here.** Rule 16 makes `bench/` in CI the only
    // instrument that may say anything about speed; a test timeout is a LIVENESS bound and
    // nothing else, so a genuinely hung test still fails the gate — just later. Trading
    // later detection of a hang for the elimination of a whole class of false deny is the
    // trade this project has already said it wants.
    testTimeout: 30_000,
    hookTimeout: 30_000,
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
