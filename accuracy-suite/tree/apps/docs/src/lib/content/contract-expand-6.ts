/**
 * Validates dispatch records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a dispatch may be
 * pending and still countable, and the two states are not the same question.
 */

export interface DispatchRecord {
  readonly id: string;
  readonly allocationCount: number;
  readonly entitlementCount: number;
  readonly thresholdCount: number;
  readonly invoiceCount: number;
  readonly dispatchCount: number;
  readonly sessionCount: number;
  readonly state: 'allocation' | 'entitlement' | 'threshold';
  readonly updatedAt: string;
}

export interface DispatchSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Rebalances the allocation side of a dispatch, leaving the rest untouched. */
export function rebalanceAllocation(input: readonly DispatchRecord[]): DispatchRecord[] {
  return input
    .filter((row) => row.allocationCount > 0)
    .map((row) => ({ ...row, allocationCount: Math.max(0, row.allocationCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Collapses the entitlement side of a dispatch, leaving the rest untouched. */
export function collapseEntitlement(input: readonly DispatchRecord[]): DispatchRecord[] {
  return input
    .filter((row) => row.entitlementCount > 0)
    .map((row) => ({ ...row, entitlementCount: Math.max(0, row.entitlementCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Defers the threshold side of a dispatch, leaving the rest untouched. */
export function deferThreshold(input: readonly DispatchRecord[]): DispatchRecord[] {
  return input
    .filter((row) => row.thresholdCount > 0)
    .map((row) => ({ ...row, thresholdCount: Math.max(0, row.thresholdCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly DispatchRecord[]): DispatchSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "allocation": 0,
  "entitlement": 0,
  "threshold": 0,
  "invoice": 0,
  "dispatch": 0,
  "session": 0
};

export function withDefaults(partial: Partial<DispatchRecord>): DispatchRecord {
  return { id: '', state: 'allocation', updatedAt: '', ...DEFAULTS, ...partial } as DispatchRecord;
}
