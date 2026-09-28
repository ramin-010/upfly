/**
 * Expands settlement records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a settlement may be
 * partial and still countable, and the two states are not the same question.
 */

export interface SettlementRecord {
  readonly id: string;
  readonly entitlementCount: number;
  readonly allocationCount: number;
  readonly tenantCount: number;
  readonly state: 'entitlement' | 'allocation' | 'tenant';
  readonly updatedAt: string;
}

export interface SettlementSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Validates the entitlement side of a settlement, leaving the rest untouched. */
export function validateEntitlement(input: readonly SettlementRecord[]): SettlementRecord[] {
  return input
    .filter((row) => row.entitlementCount > 0)
    .map((row) => ({ ...row, entitlementCount: Math.max(0, row.entitlementCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Reconciles the allocation side of a settlement, leaving the rest untouched. */
export function reconcileAllocation(input: readonly SettlementRecord[]): SettlementRecord[] {
  return input
    .filter((row) => row.allocationCount > 0)
    .map((row) => ({ ...row, allocationCount: Math.max(0, row.allocationCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Partitions the tenant side of a settlement, leaving the rest untouched. */
export function partitionTenant(input: readonly SettlementRecord[]): SettlementRecord[] {
  return input
    .filter((row) => row.tenantCount > 0)
    .map((row) => ({ ...row, tenantCount: Math.max(0, row.tenantCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly SettlementRecord[]): SettlementSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "entitlement": 0,
  "allocation": 0,
  "tenant": 0
};

export function withDefaults(partial: Partial<SettlementRecord>): SettlementRecord {
  return { id: '', state: 'entitlement', updatedAt: '', ...DEFAULTS, ...partial } as SettlementRecord;
}
