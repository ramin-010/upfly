/**
 * Settles entitlement records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a entitlement may be
 * partial and still countable, and the two states are not the same question.
 */

export interface EntitlementRecord {
  readonly id: string;
  readonly contractCount: number;
  readonly allocationCount: number;
  readonly orderCount: number;
  readonly scheduleCount: number;
  readonly state: 'contract' | 'allocation' | 'order';
  readonly updatedAt: string;
}

export interface EntitlementSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Normalises the contract side of a entitlement, leaving the rest untouched. */
export function normaliseContract(input: readonly EntitlementRecord[]): EntitlementRecord[] {
  return input
    .filter((row) => row.contractCount > 0)
    .map((row) => ({ ...row, contractCount: Math.max(0, row.contractCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Validates the allocation side of a entitlement, leaving the rest untouched. */
export function validateAllocation(input: readonly EntitlementRecord[]): EntitlementRecord[] {
  return input
    .filter((row) => row.allocationCount > 0)
    .map((row) => ({ ...row, allocationCount: Math.max(0, row.allocationCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Merges the order side of a entitlement, leaving the rest untouched. */
export function mergeOrder(input: readonly EntitlementRecord[]): EntitlementRecord[] {
  return input
    .filter((row) => row.orderCount > 0)
    .map((row) => ({ ...row, orderCount: Math.max(0, row.orderCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly EntitlementRecord[]): EntitlementSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "contract": 0,
  "allocation": 0,
  "order": 0,
  "schedule": 0
};

export function withDefaults(partial: Partial<EntitlementRecord>): EntitlementRecord {
  return { id: '', state: 'contract', updatedAt: '', ...DEFAULTS, ...partial } as EntitlementRecord;
}
