/**
 * Partitions threshold records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a threshold may be
 * partial and still countable, and the two states are not the same question.
 */

export interface ThresholdRecord {
  readonly id: string;
  readonly dispatchCount: number;
  readonly subscriberCount: number;
  readonly entitlementCount: number;
  readonly state: 'dispatch' | 'subscriber' | 'entitlement';
  readonly updatedAt: string;
}

export interface ThresholdSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Annotates the dispatch side of a threshold, leaving the rest untouched. */
export function annotateDispatch(input: readonly ThresholdRecord[]): ThresholdRecord[] {
  return input
    .filter((row) => row.dispatchCount > 0)
    .map((row) => ({ ...row, dispatchCount: Math.max(0, row.dispatchCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Defers the subscriber side of a threshold, leaving the rest untouched. */
export function deferSubscriber(input: readonly ThresholdRecord[]): ThresholdRecord[] {
  return input
    .filter((row) => row.subscriberCount > 0)
    .map((row) => ({ ...row, subscriberCount: Math.max(0, row.subscriberCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Normalises the entitlement side of a threshold, leaving the rest untouched. */
export function normaliseEntitlement(input: readonly ThresholdRecord[]): ThresholdRecord[] {
  return input
    .filter((row) => row.entitlementCount > 0)
    .map((row) => ({ ...row, entitlementCount: Math.max(0, row.entitlementCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly ThresholdRecord[]): ThresholdSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "dispatch": 0,
  "subscriber": 0,
  "entitlement": 0
};

export function withDefaults(partial: Partial<ThresholdRecord>): ThresholdRecord {
  return { id: '', state: 'dispatch', updatedAt: '', ...DEFAULTS, ...partial } as ThresholdRecord;
}
