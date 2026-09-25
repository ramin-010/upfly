/** Exit codes are part of the CLI's public contract: agents and CI branch on them. */
export const EXIT_CODES = {
  /** The command ran. For `audit` and `optimize`, findings do not change this. */
  OK: 0,
  /** `check` found findings above the configured thresholds. */
  FINDINGS: 1,
  /** The command line or the configuration file was invalid. */
  USAGE: 2,
  /** Refused to act for safety, such as a dirty git tree or another tool's config file. */
  ABORTED: 3,
  /** Failed in a way Upfly did not anticipate; the message says what happened. */
  INTERNAL: 4,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/** The version `upfly --version` prints. */
export const VERSION = '0.0.0';
