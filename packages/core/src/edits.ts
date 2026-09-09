import { UpflyError } from './errors.js';
import type { Edit } from './types.js';

/**
 * Apply range replacements to a string.
 *
 * This is the primitive every adapter's `rewrite` is built on, so it is strict on
 * purpose: rewriting a user's source file is the riskiest thing the engine does, and
 * a silently mis-applied edit is exactly the "5% failure rate" that makes a tool like
 * this untrustworthy. Anything ambiguous throws rather than guessing.
 *
 * Edits are applied from the end of the string backwards, so offsets earlier in the
 * document stay valid as we go and no offset arithmetic is needed.
 *
 * @throws {UpflyError} `INVALID_EDIT_RANGE` if a range is not a valid slice of `source`.
 * @throws {UpflyError} `OVERLAPPING_EDITS` if two edits cover overlapping text.
 * @throws {UpflyError} `AMBIGUOUS_EDITS` if two edits start at the same offset, where
 *         the result would depend on application order.
 */
export function applyEdits(source: string, edits: readonly Edit[]): string {
  if (edits.length === 0) return source;

  const ordered = validateEdits(source, edits);

  let result = source;
  // Descending by start: later edits are applied first, leaving earlier offsets intact.
  for (let i = ordered.length - 1; i >= 0; i--) {
    // Safe: `ordered` is a dense array and i is within bounds.
    const edit = ordered[i] as Edit;
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
  }
  return result;
}

/**
 * Check a set of edits against a source string and return them sorted ascending.
 *
 * Exported because the planner validates a whole run's edits before anything is
 * written to disk — failing during planning is much cheaper than failing halfway
 * through a rewrite.
 */
export function validateEdits(source: string, edits: readonly Edit[]): Edit[] {
  for (const edit of edits) {
    if (!Number.isInteger(edit.start) || !Number.isInteger(edit.end)) {
      throw new UpflyError(
        'INVALID_EDIT_RANGE',
        `Edit offsets must be integers, received start=${edit.start} end=${edit.end}.`,
      );
    }
    if (edit.start < 0 || edit.end < edit.start || edit.end > source.length) {
      throw new UpflyError(
        'INVALID_EDIT_RANGE',
        `Edit range [${edit.start}, ${edit.end}) is not within a source of length ${source.length}.`,
      );
    }
  }

  const ordered = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);

  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1] as Edit;
    const current = ordered[i] as Edit;

    if (current.start === previous.start) {
      throw new UpflyError(
        'AMBIGUOUS_EDITS',
        `Two edits start at offset ${current.start}; the result would depend on which is applied first.`,
      );
    }
    if (current.start < previous.end) {
      throw new UpflyError(
        'OVERLAPPING_EDITS',
        `Edit [${current.start}, ${current.end}) overlaps [${previous.start}, ${previous.end}).`,
      );
    }
  }

  return ordered;
}
