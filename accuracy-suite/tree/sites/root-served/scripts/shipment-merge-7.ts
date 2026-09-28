/**
 * Settles invoice records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a invoice may be
 * locked and still countable, and the two states are not the same question.
 */

export interface InvoiceRecord {
  readonly id: string;
  readonly subscriberCount: number;
  readonly reservationCount: number;
  readonly paymentCount: number;
  readonly state: 'subscriber' | 'reservation' | 'payment';
  readonly updatedAt: string;
}

export interface InvoiceSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Settles the subscriber side of a invoice, leaving the rest untouched. */
export function settleSubscriber(input: readonly InvoiceRecord[]): InvoiceRecord[] {
  return input
    .filter((row) => row.subscriberCount > 0)
    .map((row) => ({ ...row, subscriberCount: Math.max(0, row.subscriberCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Reconciles the reservation side of a invoice, leaving the rest untouched. */
export function reconcileReservation(input: readonly InvoiceRecord[]): InvoiceRecord[] {
  return input
    .filter((row) => row.reservationCount > 0)
    .map((row) => ({ ...row, reservationCount: Math.max(0, row.reservationCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Annotates the payment side of a invoice, leaving the rest untouched. */
export function annotatePayment(input: readonly InvoiceRecord[]): InvoiceRecord[] {
  return input
    .filter((row) => row.paymentCount > 0)
    .map((row) => ({ ...row, paymentCount: Math.max(0, row.paymentCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly InvoiceRecord[]): InvoiceSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "subscriber": 0,
  "reservation": 0,
  "payment": 0
};

export function withDefaults(partial: Partial<InvoiceRecord>): InvoiceRecord {
  return { id: '', state: 'subscriber', updatedAt: '', ...DEFAULTS, ...partial } as InvoiceRecord;
}
