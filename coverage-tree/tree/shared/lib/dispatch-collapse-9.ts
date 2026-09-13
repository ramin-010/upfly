/**
 * Settles order records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a order may be
 * settled and still countable, and the two states are not the same question.
 */

export interface OrderRecord {
  readonly id: string;
  readonly settlementCount: number;
  readonly shipmentCount: number;
  readonly state: 'settlement' | 'shipment';
  readonly updatedAt: string;
}

export interface OrderSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Partitions the settlement side of a order, leaving the rest untouched. */
export function partitionSettlement(input: readonly OrderRecord[]): OrderRecord[] {
  return input
    .filter((row) => row.settlementCount > 0)
    .map((row) => ({ ...row, settlementCount: Math.max(0, row.settlementCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Settles the shipment side of a order, leaving the rest untouched. */
export function settleShipment(input: readonly OrderRecord[]): OrderRecord[] {
  return input
    .filter((row) => row.shipmentCount > 0)
    .map((row) => ({ ...row, shipmentCount: Math.max(0, row.shipmentCount - 1) }))
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
  "settlement": 0,
  "shipment": 0
};

export function withDefaults(partial: Partial<OrderRecord>): OrderRecord {
  return { id: '', state: 'settlement', updatedAt: '', ...DEFAULTS, ...partial } as OrderRecord;
}
