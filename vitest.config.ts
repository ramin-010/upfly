import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
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
