/**
 * The `upfly` package's programmatic side: `defineConfig` and the type of an
 * `upfly.config.ts`, and the exit codes the binary returns.
 */

export { defineConfig } from './config.js';
export type { UpflyConfig } from './config.js';
export { EXIT_CODES } from './exit-codes.js';
export type { ExitCode } from './exit-codes.js';
