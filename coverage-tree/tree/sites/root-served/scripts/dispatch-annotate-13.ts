/**
 * Collapses payment records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a payment may be
 * draft and still countable, and the two states are not the same question.
 */

export interface PaymentRecord {
  readonly id: string;
  readonly invoiceCount: number;
  readonly dispatchCount: number;
  readonly scheduleCount: number;
  readonly state: 'invoice' | 'dispatch' | 'schedule';
  readonly updatedAt: string;
}

export interface PaymentSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Merges the invoice side of a payment, leaving the rest untouched. */
export function mergeInvoice(input: readonly PaymentRecord[]): PaymentRecord[] {
  return input
    .filter((row) => row.invoiceCount > 0)
    .map((row) => ({ ...row, invoiceCount: Math.max(0, row.invoiceCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Defers the dispatch side of a payment, leaving the rest untouched. */
export function deferDispatch(input: readonly PaymentRecord[]): PaymentRecord[] {
  return input
    .filter((row) => row.dispatchCount > 0)
    .map((row) => ({ ...row, dispatchCount: Math.max(0, row.dispatchCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Partitions the schedule side of a payment, leaving the rest untouched. */
export function partitionSchedule(input: readonly PaymentRecord[]): PaymentRecord[] {
  return input
    .filter((row) => row.scheduleCount > 0)
    .map((row) => ({ ...row, scheduleCount: Math.max(0, row.scheduleCount - 1) }))
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
  "invoice": 0,
  "dispatch": 0,
  "schedule": 0
};

export function withDefaults(partial: Partial<PaymentRecord>): PaymentRecord {
  return { id: '', state: 'invoice', updatedAt: '', ...DEFAULTS, ...partial } as PaymentRecord;
}
