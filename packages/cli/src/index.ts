/**
 * Programmatic entry point for the CLI package.
 *
 * Commands land here in Phase 3. Until then this exists so the workspace graph,
 * project references and release tooling are exercised by CI from day one.
 */

export const VERSION = '0.0.0';

/** Exit codes are part of the CLI's public contract — agents and CI branch on them. */
export const EXIT_CODES = {
  /** Success, nothing to report. */
  OK: 0,
  /** `check` found findings above the configured thresholds. */
  FINDINGS: 1,
  /** The command line was invalid. */
  USAGE: 2,
  /** Refused to act for safety, e.g. a dirty git tree without --allow-dirty. */
  ABORTED: 3,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
