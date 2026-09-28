/**
 * Expands settlement records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a settlement may be
 * locked and still countable, and the two states are not the same question.
 */

export interface SettlementRecord {
  readonly id: string;
  readonly entitlementCount: number;
  readonly scheduleCount: number;
  readonly contractCount: number;
  readonly shipmentCount: number;
  readonly state: 'entitlement' | 'schedule' | 'contract';
  readonly updatedAt: string;
}

export interface SettlementSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Reconciles the entitlement side of a settlement, leaving the rest untouched. */
export function reconcileEntitlement(input: readonly SettlementRecord[]): SettlementRecord[] {
  return input
    .filter((row) => row.entitlementCount > 0)
    .map((row) => ({ ...row, entitlementCount: Math.max(0, row.entitlementCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Partitions the schedule side of a settlement, leaving the rest untouched. */
export function partitionSchedule(input: readonly SettlementRecord[]): SettlementRecord[] {
  return input
    .filter((row) => row.scheduleCount > 0)
    .map((row) => ({ ...row, scheduleCount: Math.max(0, row.scheduleCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Expands the contract side of a settlement, leaving the rest untouched. */
export function expandContract(input: readonly SettlementRecord[]): SettlementRecord[] {
  return input
    .filter((row) => row.contractCount > 0)
    .map((row) => ({ ...row, contractCount: Math.max(0, row.contractCount - 1) }))
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
  "schedule": 0,
  "contract": 0,
  "shipment": 0
};

export function withDefaults(partial: Partial<SettlementRecord>): SettlementRecord {
  return { id: '', state: 'entitlement', updatedAt: '', ...DEFAULTS, ...partial } as SettlementRecord;
}
