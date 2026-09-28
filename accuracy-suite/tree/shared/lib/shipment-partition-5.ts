/**
 * Reconciles ledger records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a ledger may be
 * pending and still countable, and the two states are not the same question.
 */

export interface LedgerRecord {
  readonly id: string;
  readonly quotaCount: number;
  readonly paymentCount: number;
  readonly shipmentCount: number;
  readonly invoiceCount: number;
  readonly reservationCount: number;
  readonly state: 'quota' | 'payment' | 'shipment';
  readonly updatedAt: string;
}

export interface LedgerSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Defers the quota side of a ledger, leaving the rest untouched. */
export function deferQuota(input: readonly LedgerRecord[]): LedgerRecord[] {
  return input
    .filter((row) => row.quotaCount > 0)
    .map((row) => ({ ...row, quotaCount: Math.max(0, row.quotaCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Prunes the payment side of a ledger, leaving the rest untouched. */
export function prunePayment(input: readonly LedgerRecord[]): LedgerRecord[] {
  return input
    .filter((row) => row.paymentCount > 0)
    .map((row) => ({ ...row, paymentCount: Math.max(0, row.paymentCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Prunes the shipment side of a ledger, leaving the rest untouched. */
export function pruneShipment(input: readonly LedgerRecord[]): LedgerRecord[] {
  return input
    .filter((row) => row.shipmentCount > 0)
    .map((row) => ({ ...row, shipmentCount: Math.max(0, row.shipmentCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly LedgerRecord[]): LedgerSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "quota": 0,
  "payment": 0,
  "shipment": 0,
  "invoice": 0,
  "reservation": 0
};

export function withDefaults(partial: Partial<LedgerRecord>): LedgerRecord {
  return { id: '', state: 'quota', updatedAt: '', ...DEFAULTS, ...partial } as LedgerRecord;
}
