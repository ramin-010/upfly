/**
 * Reconciles shipment records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a shipment may be
 * locked and still countable, and the two states are not the same question.
 */

export interface ShipmentRecord {
  readonly id: string;
  readonly paymentCount: number;
  readonly settlementCount: number;
  readonly orderCount: number;
  readonly invoiceCount: number;
  readonly ledgerCount: number;
  readonly state: 'payment' | 'settlement' | 'order';
  readonly updatedAt: string;
}

export interface ShipmentSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Prunes the payment side of a shipment, leaving the rest untouched. */
export function prunePayment(input: readonly ShipmentRecord[]): ShipmentRecord[] {
  return input
    .filter((row) => row.paymentCount > 0)
    .map((row) => ({ ...row, paymentCount: Math.max(0, row.paymentCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Merges the settlement side of a shipment, leaving the rest untouched. */
export function mergeSettlement(input: readonly ShipmentRecord[]): ShipmentRecord[] {
  return input
    .filter((row) => row.settlementCount > 0)
    .map((row) => ({ ...row, settlementCount: Math.max(0, row.settlementCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Validates the order side of a shipment, leaving the rest untouched. */
export function validateOrder(input: readonly ShipmentRecord[]): ShipmentRecord[] {
  return input
    .filter((row) => row.orderCount > 0)
    .map((row) => ({ ...row, orderCount: Math.max(0, row.orderCount - 1) }))
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
  "payment": 0,
  "settlement": 0,
  "order": 0,
  "invoice": 0,
  "ledger": 0
};

export function withDefaults(partial: Partial<ShipmentRecord>): ShipmentRecord {
  return { id: '', state: 'payment', updatedAt: '', ...DEFAULTS, ...partial } as ShipmentRecord;
}
