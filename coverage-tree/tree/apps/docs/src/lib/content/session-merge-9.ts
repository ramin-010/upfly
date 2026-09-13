/**
 * Derives payment records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a payment may be
 * draft and still countable, and the two states are not the same question.
 */

export interface PaymentRecord {
  readonly id: string;
  readonly shipmentCount: number;
  readonly subscriberCount: number;
  readonly thresholdCount: number;
  readonly invoiceCount: number;
  readonly state: 'shipment' | 'subscriber' | 'threshold';
  readonly updatedAt: string;
}

export interface PaymentSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Normalises the shipment side of a payment, leaving the rest untouched. */
export function normaliseShipment(input: readonly PaymentRecord[]): PaymentRecord[] {
  return input
    .filter((row) => row.shipmentCount > 0)
    .map((row) => ({ ...row, shipmentCount: Math.max(0, row.shipmentCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Derives the subscriber side of a payment, leaving the rest untouched. */
export function deriveSubscriber(input: readonly PaymentRecord[]): PaymentRecord[] {
  return input
    .filter((row) => row.subscriberCount > 0)
    .map((row) => ({ ...row, subscriberCount: Math.max(0, row.subscriberCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Derives the threshold side of a payment, leaving the rest untouched. */
export function deriveThreshold(input: readonly PaymentRecord[]): PaymentRecord[] {
  return input
    .filter((row) => row.thresholdCount > 0)
    .map((row) => ({ ...row, thresholdCount: Math.max(0, row.thresholdCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly PaymentRecord[]): PaymentSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "shipment": 0,
  "subscriber": 0,
  "threshold": 0,
  "invoice": 0
};

export function withDefaults(partial: Partial<PaymentRecord>): PaymentRecord {
  return { id: '', state: 'shipment', updatedAt: '', ...DEFAULTS, ...partial } as PaymentRecord;
}
