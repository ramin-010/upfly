/**
 * Number formatting for anything a person reads.
 *
 * Extracted when a second module needed it: the sweep's skip reason said *"larger
 * than the 2097152-byte sweep limit"*, which is a number nobody reads, and the
 * renderer already knew how to say `2 MB`. Duplicating the formatter would have been
 * the worse of the two fixes, and hard-coding megabytes was the version that broke —
 * a 100-byte limit rounds to `0 MB`.
 *
 * ⚠️ **No `toLocaleString`, no `Intl`.** Locale-dependent formatting renders `1,5 MB`
 * on some machines, which makes rule 11's byte-identical report quietly false in
 * exactly the way `localeCompare` would. Every number here is built by hand.
 */

/** A byte count at human scale: `840 B`, `2 MB`, `1.4 GB`. */
export function formatBytes(value: number): string {
  if (value < 1_000) return `${value} B`;
  if (value < 1_000_000) return `${tenths(value / 1_000)} KB`;
  if (value < 1_000_000_000) return `${tenths(value / 1_000_000)} MB`;
  return `${tenths(value / 1_000_000_000)} GB`;
}

/** One decimal place, without a trailing `.0`, and without locale rules. */
function tenths(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
}

/**
 * `1 file`, `2 files` — a count and its noun, agreeing.
 *
 * Moved here from `report.ts` when R72's disclosure became the second consumer, which
 * is the same reason `formatBytes` is here.
 *
 * ⚠️ **It does not fix the bug it looks like it fixes.** This agrees the *noun* with
 * the count; it cannot agree the *verb*, and the verb is what has gone wrong — the
 * report has shipped `1 file were not read`, and `report.ts` records that happening a
 * further three times in one file. The construction that cannot carry the bug is an
 * invariant subject (`… so 1 file went unread`), not a helper. Reach for the sentence
 * shape first and this second.
 */
export function plural(value: number, noun: string, plural_?: string): string {
  return `${value} ${value === 1 ? noun : (plural_ ?? `${noun}s`)}`;
}
