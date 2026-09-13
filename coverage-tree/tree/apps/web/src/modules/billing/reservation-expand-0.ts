/**
 * Rebalances subscriber records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a subscriber may be
 * settled and still countable, and the two states are not the same question.
 */

export interface SubscriberRecord {
  readonly id: string;
  readonly dispatchCount: number;
  readonly entitlementCount: number;
  readonly allocationCount: number;
  readonly state: 'dispatch' | 'entitlement' | 'allocation';
  readonly updatedAt: string;
}

export interface SubscriberSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Expands the dispatch side of a subscriber, leaving the rest untouched. */
export function expandDispatch(input: readonly SubscriberRecord[]): SubscriberRecord[] {
  return input
    .filter((row) => row.dispatchCount > 0)
    .map((row) => ({ ...row, dispatchCount: Math.max(0, row.dispatchCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Collapses the entitlement side of a subscriber, leaving the rest untouched. */
export function collapseEntitlement(input: readonly SubscriberRecord[]): SubscriberRecord[] {
  return input
    .filter((row) => row.entitlementCount > 0)
    .map((row) => ({ ...row, entitlementCount: Math.max(0, row.entitlementCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Replays the allocation side of a subscriber, leaving the rest untouched. */
export function replayAllocation(input: readonly SubscriberRecord[]): SubscriberRecord[] {
  return input
    .filter((row) => row.allocationCount > 0)
    .map((row) => ({ ...row, allocationCount: Math.max(0, row.allocationCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly SubscriberRecord[]): SubscriberSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "dispatch": 0,
  "entitlement": 0,
  "allocation": 0
};

export function withDefaults(partial: Partial<SubscriberRecord>): SubscriberRecord {
  return { id: '', state: 'dispatch', updatedAt: '', ...DEFAULTS, ...partial } as SubscriberRecord;
}
