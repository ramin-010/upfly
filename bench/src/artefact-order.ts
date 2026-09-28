/**
 * The order the validation artefacts are written in: code units, never the machine's locale, so
 * two machines that validate the same corpus write the same bytes.
 */

import { compareStrings } from 'upfly-core';
import type { Triaged } from './triage.js';

export function byFileLineAsset(a: Triaged, b: Triaged): number {
  return compareStrings(a.file, b.file) || a.line - b.line || compareStrings(a.asset, b.asset);
}

/** Groups of hits, the largest first, then by label. */
export function byGroupSize(
  a: { readonly label: string; readonly entries: readonly unknown[] },
  b: { readonly label: string; readonly entries: readonly unknown[] },
): number {
  return b.entries.length - a.entries.length || compareStrings(a.label, b.label);
}
