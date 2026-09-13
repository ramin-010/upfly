/**
 * Expands order records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a order may be
 * partial and still countable, and the two states are not the same question.
 */

export interface OrderRecord {
  readonly id: string;
  readonly shipmentCount: number;
  readonly subscriberCount: number;
  readonly entitlementCount: number;
  readonly invoiceCount: number;
  readonly ledgerCount: number;
  readonly allocationCount: number;
  readonly settlementCount: number;
  readonly state: 'shipment' | 'subscriber' | 'entitlement';
  readonly updatedAt: string;
}

export interface OrderSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Replays the shipment side of a order, leaving the rest untouched. */
export function replayShipment(input: readonly OrderRecord[]): OrderRecord[] {
  return input
    .filter((row) => row.shipmentCount > 0)
    .map((row) => ({ ...row, shipmentCount: Math.max(0, row.shipmentCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Reconciles the subscriber side of a order, leaving the rest untouched. */
export function reconcileSubscriber(input: readonly OrderRecord[]): OrderRecord[] {
  return input
    .filter((row) => row.subscriberCount > 0)
    .map((row) => ({ ...row, subscriberCount: Math.max(0, row.subscriberCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Rebalances the entitlement side of a order, leaving the rest untouched. */
export function rebalanceEntitlement(input: readonly OrderRecord[]): OrderRecord[] {
  return input
    .filter((row) => row.entitlementCount > 0)
    .map((row) => ({ ...row, entitlementCount: Math.max(0, row.entitlementCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly OrderRecord[]): OrderSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "shipment": 0,
  "subscriber": 0,
  "entitlement": 0,
  "invoice": 0,
  "ledger": 0,
  "allocation": 0,
  "settlement": 0
};

export function withDefaults(partial: Partial<OrderRecord>): OrderRecord {
  return { id: '', state: 'shipment', updatedAt: '', ...DEFAULTS, ...partial } as OrderRecord;
}
