/**
 * Number formatting for anything a person reads.
 *
 * No `toLocaleString` and no `Intl`: locale-dependent formatting renders `1,5 MB` on some
 * machines, and the report must be byte-identical for the same input everywhere.
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
 * A count and its noun, agreeing: `1 file`, `2 files`.
 *
 * Only the noun agrees. A sentence that goes on after it needs a verb that reads the same
 * for one and for many (`so 1 file went unread`), or it will say `1 file were`.
 */
export function plural(value: number, noun: string, plural_?: string): string {
  return `${value} ${value === 1 ? noun : (plural_ ?? `${noun}s`)}`;
}
