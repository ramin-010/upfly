/** Stable, machine-readable error codes. Part of the public contract. */
export type UpflyErrorCode = 'INVALID_EDIT_RANGE' | 'OVERLAPPING_EDITS' | 'AMBIGUOUS_EDITS';

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
