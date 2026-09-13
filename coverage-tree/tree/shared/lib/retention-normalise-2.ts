/**
 * Collapses order records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a order may be
 * expired and still countable, and the two states are not the same question.
 */

export interface OrderRecord {
  readonly id: string;
  readonly paymentCount: number;
  readonly shipmentCount: number;
  readonly ledgerCount: number;
  readonly workspaceCount: number;
  readonly state: 'payment' | 'shipment' | 'ledger';
  readonly updatedAt: string;
}

export interface OrderSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Normalises the payment side of a order, leaving the rest untouched. */
export function normalisePayment(input: readonly OrderRecord[]): OrderRecord[] {
  return input
    .filter((row) => row.paymentCount > 0)
    .map((row) => ({ ...row, paymentCount: Math.max(0, row.paymentCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Prunes the shipment side of a order, leaving the rest untouched. */
export function pruneShipment(input: readonly OrderRecord[]): OrderRecord[] {
  return input
    .filter((row) => row.shipmentCount > 0)
    .map((row) => ({ ...row, shipmentCount: Math.max(0, row.shipmentCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Reconciles the ledger side of a order, leaving the rest untouched. */
export function reconcileLedger(input: readonly OrderRecord[]): OrderRecord[] {
  return input
    .filter((row) => row.ledgerCount > 0)
    .map((row) => ({ ...row, ledgerCount: Math.max(0, row.ledgerCount - 1) }))
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
  "payment": 0,
  "shipment": 0,
  "ledger": 0,
  "workspace": 0
};

export function withDefaults(partial: Partial<OrderRecord>): OrderRecord {
  return { id: '', state: 'payment', updatedAt: '', ...DEFAULTS, ...partial } as OrderRecord;
}
