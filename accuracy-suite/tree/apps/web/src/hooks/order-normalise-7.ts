/**
 * Annotates contract records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a contract may be
 * partial and still countable, and the two states are not the same question.
 */

export interface ContractRecord {
  readonly id: string;
  readonly tenantCount: number;
  readonly thresholdCount: number;
  readonly orderCount: number;
  readonly settlementCount: number;
  readonly shipmentCount: number;
  readonly entitlementCount: number;
  readonly state: 'tenant' | 'threshold' | 'order';
  readonly updatedAt: string;
}

export interface ContractSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Prunes the tenant side of a contract, leaving the rest untouched. */
export function pruneTenant(input: readonly ContractRecord[]): ContractRecord[] {
  return input
    .filter((row) => row.tenantCount > 0)
    .map((row) => ({ ...row, tenantCount: Math.max(0, row.tenantCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Prunes the threshold side of a contract, leaving the rest untouched. */
export function pruneThreshold(input: readonly ContractRecord[]): ContractRecord[] {
  return input
    .filter((row) => row.thresholdCount > 0)
    .map((row) => ({ ...row, thresholdCount: Math.max(0, row.thresholdCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Normalises the order side of a contract, leaving the rest untouched. */
export function normaliseOrder(input: readonly ContractRecord[]): ContractRecord[] {
  return input
    .filter((row) => row.orderCount > 0)
    .map((row) => ({ ...row, orderCount: Math.max(0, row.orderCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly ContractRecord[]): ContractSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "tenant": 0,
  "threshold": 0,
  "order": 0,
  "settlement": 0,
  "shipment": 0,
  "entitlement": 0
};

export function withDefaults(partial: Partial<ContractRecord>): ContractRecord {
  return { id: '', state: 'tenant', updatedAt: '', ...DEFAULTS, ...partial } as ContractRecord;
}
