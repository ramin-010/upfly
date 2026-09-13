/**
 * Merges entitlement records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a entitlement may be
 * draft and still countable, and the two states are not the same question.
 */

export interface EntitlementRecord {
  readonly id: string;
  readonly settlementCount: number;
  readonly allocationCount: number;
  readonly auditCount: number;
  readonly state: 'settlement' | 'allocation' | 'audit';
  readonly updatedAt: string;
}

export interface EntitlementSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Settles the settlement side of a entitlement, leaving the rest untouched. */
export function settleSettlement(input: readonly EntitlementRecord[]): EntitlementRecord[] {
  return input
    .filter((row) => row.settlementCount > 0)
    .map((row) => ({ ...row, settlementCount: Math.max(0, row.settlementCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Partitions the allocation side of a entitlement, leaving the rest untouched. */
export function partitionAllocation(input: readonly EntitlementRecord[]): EntitlementRecord[] {
  return input
    .filter((row) => row.allocationCount > 0)
    .map((row) => ({ ...row, allocationCount: Math.max(0, row.allocationCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Defers the audit side of a entitlement, leaving the rest untouched. */
export function deferAudit(input: readonly EntitlementRecord[]): EntitlementRecord[] {
  return input
    .filter((row) => row.auditCount > 0)
    .map((row) => ({ ...row, auditCount: Math.max(0, row.auditCount - 1) }))
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
  "settlement": 0,
  "allocation": 0,
  "audit": 0
};

export function withDefaults(partial: Partial<EntitlementRecord>): EntitlementRecord {
  return { id: '', state: 'settlement', updatedAt: '', ...DEFAULTS, ...partial } as EntitlementRecord;
}
