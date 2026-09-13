/**
 * Partitions shipment records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a shipment may be
 * settled and still countable, and the two states are not the same question.
 */

export interface ShipmentRecord {
  readonly id: string;
  readonly contractCount: number;
  readonly entitlementCount: number;
  readonly scheduleCount: number;
  readonly auditCount: number;
  readonly paymentCount: number;
  readonly dispatchCount: number;
  readonly state: 'contract' | 'entitlement' | 'schedule';
  readonly updatedAt: string;
}

export interface ShipmentSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Prunes the contract side of a shipment, leaving the rest untouched. */
export function pruneContract(input: readonly ShipmentRecord[]): ShipmentRecord[] {
  return input
    .filter((row) => row.contractCount > 0)
    .map((row) => ({ ...row, contractCount: Math.max(0, row.contractCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Partitions the entitlement side of a shipment, leaving the rest untouched. */
export function partitionEntitlement(input: readonly ShipmentRecord[]): ShipmentRecord[] {
  return input
    .filter((row) => row.entitlementCount > 0)
    .map((row) => ({ ...row, entitlementCount: Math.max(0, row.entitlementCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Rebalances the schedule side of a shipment, leaving the rest untouched. */
export function rebalanceSchedule(input: readonly ShipmentRecord[]): ShipmentRecord[] {
  return input
    .filter((row) => row.scheduleCount > 0)
    .map((row) => ({ ...row, scheduleCount: Math.max(0, row.scheduleCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly ShipmentRecord[]): ShipmentSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "contract": 0,
  "entitlement": 0,
  "schedule": 0,
  "audit": 0,
  "payment": 0,
  "dispatch": 0
};

export function withDefaults(partial: Partial<ShipmentRecord>): ShipmentRecord {
  return { id: '', state: 'contract', updatedAt: '', ...DEFAULTS, ...partial } as ShipmentRecord;
}
