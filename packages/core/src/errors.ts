/** Stable, machine-readable error codes. Part of the public contract. */
export type UpflyErrorCode =
  | 'INVALID_EDIT_RANGE'
  | 'OVERLAPPING_EDITS'
  | 'AMBIGUOUS_EDITS'
  /** The discovery root does not exist or is not a directory. */
  | 'ROOT_NOT_A_DIRECTORY'
  /** Two adapters claim the same file extension, so the winner would be arbitrary. */
  | 'ADAPTER_EXTENSION_CONFLICT'
  /**
   * An adapter could not parse a file it was handed. Never swallowed: the file is still
   * reported as one that could not be parsed.
   */
  | 'ADAPTER_PARSE_FAILED'
  /**
   * A file names an adapter that was not supplied, because scanning used a different
   * adapter set from discovery. An error because the quiet alternative is a file going
   * unread and an asset wrongly looking dead.
   */
  | 'ADAPTER_NOT_REGISTERED'
  /**
   * A reference linked to a path that is not in the asset set: the references were
   * resolved against one asset set and graphed against another. An error because the
   * quiet version of this bug is an asset reported dead that is not.
   */
  | 'GRAPH_UNKNOWN_ASSET'
  /**
   * A plan failed its checks before anything was written. The tree is untouched, and
   * the message names the operation and what was wrong with it.
   */
  | 'TRANSACTION_PLAN_INVALID'
  /**
   * Something outside the run changed a file the run touches, and both directions refuse
   * rather than write over it. Commit will not apply edit offsets to text that has moved
   * since the plan was checked; undo will not revert a file matching neither the state
   * the run found nor the state it left, and will not start when the backup of a removed
   * original is gone. The files are always named, so whoever changed them can find out.
   */
  | 'TRANSACTION_FOREIGN_CHANGE'
  /**
   * Another run holds the project lock, so this one will not start. It is refused rather
   * than queued, since a queued run stalls silently behind a long one. The message names
   * the run, its process and when it started, so the user can tell whether anything is
   * still running.
   */
  | 'TRANSACTION_LOCKED'
  /**
   * The last run stopped before it finished, and a new run's manifest would replace the
   * only record of what it wrote and where its backups are. Revert it first.
   */
  | 'TRANSACTION_INTERRUPTED'
  /**
   * A manifest this build cannot use: its schema version is not this build's, or its
   * hashes were made with a different algorithm.
   */
  | 'MANIFEST_VERSION_UNSUPPORTED';

/**
 * An error the engine throws on purpose, with a stable `code`.
 *
 * Callers (the CLI, the extension, an agent reading JSON) can branch on the code without
 * matching a message that may change.
 */
export class UpflyError extends Error {
  readonly code: UpflyErrorCode;

  /**
   * References the adapter had already found when it failed.
   *
   * An adapter for a composite format finds references before it reaches the part it
   * cannot parse: the Markdown adapter collects every `![](hero.png)` before passing the
   * text to the HTML adapter, which hands any `<style>` block to the CSS adapter. The
   * failure is still thrown and the file still reported as not parsed, but the references
   * found first survive it, so one bad stylesheet does not make every image look dead.
   *
   * `unknown[]` rather than `RawReference[]` so this module does not depend on `types.ts`;
   * `scan` narrows it where it reads it.
   */
  readonly partial: readonly unknown[];

  /**
   * What a third-party parser such as PostCSS or Babel said, kept for somebody debugging
   * an adapter. `message` is ours and is what the report carries; this text changes
   * between library versions, so it would make the report differ for the same input.
   * `scan` passes it to a diagnostic channel, and the value the report is built from has
   * no field for it.
   * See "The recorded reason is ours, and the library's is not in the report" in ARCHITECTURE.md.
   *
   * `''` when the failure was ours to begin with and no library spoke.
   */
  readonly diagnostic: string;

  constructor(
    code: UpflyErrorCode,
    message: string,
    partial: readonly unknown[] = [],
    diagnostic = '',
  ) {
    super(message);
    this.name = 'UpflyError';
    this.code = code;
    this.partial = partial;
    this.diagnostic = diagnostic;
  }
}
