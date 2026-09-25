/**
 * The `upfly` package's programmatic side: the types for `upfly.config.ts`, the exit codes
 * the binary returns, and `main`, which runs one invocation the way the binary does.
 */

export { defineConfig } from './config.js';
export type { UpflyConfig } from './config.js';
export { EXIT_CODES, VERSION } from './exit-codes.js';
export type { ExitCode } from './exit-codes.js';
export { main } from './main.js';
export type { Io, Output } from './output.js';
