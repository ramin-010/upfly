/** Stable, machine-readable error codes. Part of the public contract. */
export type UpflyErrorCode =
  | 'INVALID_EDIT_RANGE'
  | 'OVERLAPPING_EDITS'
  | 'AMBIGUOUS_EDITS'
  /** The discovery root does not exist or is not a directory. */
  | 'ROOT_NOT_A_DIRECTORY'
  /** Two adapters claim the same file extension, so the winner would be arbitrary. */
  | 'ADAPTER_EXTENSION_CONFLICT'
  /** An adapter could not parse a file it was handed. Never swallowed: see rule 9. */
  | 'ADAPTER_PARSE_FAILED'
  /**
   * A file names an adapter that was not supplied — scanning with a different
   * adapter set than discovery used. Loud because the quiet alternative is a file
   * going unread and an asset silently looking dead.
   */
  | 'ADAPTER_NOT_REGISTERED'
  /**
   * A reference linked to a path that is not in the asset set — references resolved
   * against one asset set and graphed against another. Loud because the quiet
   * version of this bug is a phantom dead asset.
   */
  | 'GRAPH_UNKNOWN_ASSET'
  /**
   * A plan failed its checks before anything was written. The tree is untouched, and
   * the message names the operation and what was wrong with it.
   */
  | 'TRANSACTION_PLAN_INVALID'
  /**
   * A file the run was to rewrite was changed by something outside the run, and the
   * two directions both refuse rather than write over it. Commit will not apply edit
   * offsets to text that has moved since the plan was checked; undo will not revert
   * a file matching neither the state the run found nor the state it left. The file
   * is always named, because the quiet alternative is losing whoever changed it.
   */
  | 'TRANSACTION_FOREIGN_CHANGE'
  /** A manifest written by a build whose schema this one does not understand. */
  | 'MANIFEST_VERSION_UNSUPPORTED';

/**
 * All errors the engine throws deliberately.
 *
 * Carrying a `code` means callers (the CLI, the extension, an agent reading JSON)
 * can branch on the failure without string-matching a message that may change.
 */
export class UpflyError extends Error {
  readonly code: UpflyErrorCode;

  /**
   * References the adapter had already found when it failed (R20).
   *
   * An adapter that reads a composite format finds things and *then* hits the part
   * it cannot parse. The Markdown adapter collects every `![](hero.png)` before
   * handing the same text to the HTML adapter, which hands a `<style>` block to the
   * CSS adapter — so one unparseable stylesheet inside one Markdown file threw away
   * every image reference in the document.
   *
   * ⚠️ **This is not permission to swallow the failure.** The throw still happens,
   * `scan` still records the file as `parse-failed`, and the report still names it —
   * rule 9 is untouched. What changes is that the references found *before* the
   * failure survive it, because they are correct and losing them is what makes the
   * asset look dead.
   *
   * Typed as `unknown[]` rather than `RawReference[]` so `errors.ts` stays free of
   * a dependency on `types.ts`; `scan` narrows it at the single place it is read.
   */
  readonly partial: readonly unknown[];

  constructor(code: UpflyErrorCode, message: string, partial: readonly unknown[] = []) {
    super(message);
    this.name = 'UpflyError';
    this.code = code;
    this.partial = partial;
  }
}
