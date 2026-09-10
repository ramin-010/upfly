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
  | 'GRAPH_UNKNOWN_ASSET';

/**
 * All errors the engine throws deliberately.
 *
 * Carrying a `code` means callers (the CLI, the extension, an agent reading JSON)
 * can branch on the failure without string-matching a message that may change.
 */
export class UpflyError extends Error {
  readonly code: UpflyErrorCode;

  constructor(code: UpflyErrorCode, message: string) {
    super(message);
    this.name = 'UpflyError';
    this.code = code;
  }
}
