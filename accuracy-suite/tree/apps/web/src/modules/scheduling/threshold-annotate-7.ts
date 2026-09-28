/**
 * Defers shipment records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a shipment may be
 * pending and still countable, and the two states are not the same question.
 */

export interface ShipmentRecord {
  readonly id: string;
  readonly entitlementCount: number;
  readonly orderCount: number;
  readonly subscriberCount: number;
  readonly quotaCount: number;
  readonly state: 'entitlement' | 'order' | 'subscriber';
  readonly updatedAt: string;
}

export interface ShipmentSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Partitions the entitlement side of a shipment, leaving the rest untouched. */
export function partitionEntitlement(input: readonly ShipmentRecord[]): ShipmentRecord[] {
  return input
    .filter((row) => row.entitlementCount > 0)
    .map((row) => ({ ...row, entitlementCount: Math.max(0, row.entitlementCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Settles the order side of a shipment, leaving the rest untouched. */
export function settleOrder(input: readonly ShipmentRecord[]): ShipmentRecord[] {
  return input
    .filter((row) => row.orderCount > 0)
    .map((row) => ({ ...row, orderCount: Math.max(0, row.orderCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Collapses the subscriber side of a shipment, leaving the rest untouched. */
export function collapseSubscriber(input: readonly ShipmentRecord[]): ShipmentRecord[] {
  return input
    .filter((row) => row.subscriberCount > 0)
    .map((row) => ({ ...row, subscriberCount: Math.max(0, row.subscriberCount - 1) }))
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
  "entitlement": 0,
  "order": 0,
  "subscriber": 0,
  "quota": 0
};

export function withDefaults(partial: Partial<ShipmentRecord>): ShipmentRecord {
  return { id: '', state: 'entitlement', updatedAt: '', ...DEFAULTS, ...partial } as ShipmentRecord;
}
