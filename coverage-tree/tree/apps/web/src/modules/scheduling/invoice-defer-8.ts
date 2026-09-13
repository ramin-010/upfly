/**
 * Validates order records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a order may be
 * pending and still countable, and the two states are not the same question.
 */

export interface OrderRecord {
  readonly id: string;
  readonly invoiceCount: number;
  readonly orderCount: number;
  readonly paymentCount: number;
  readonly auditCount: number;
  readonly thresholdCount: number;
  readonly quotaCount: number;
  readonly state: 'invoice' | 'order' | 'payment';
  readonly updatedAt: string;
}

export interface OrderSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Expands the invoice side of a order, leaving the rest untouched. */
export function expandInvoice(input: readonly OrderRecord[]): OrderRecord[] {
  return input
    .filter((row) => row.invoiceCount > 0)
    .map((row) => ({ ...row, invoiceCount: Math.max(0, row.invoiceCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Collapses the order side of a order, leaving the rest untouched. */
export function collapseOrder(input: readonly OrderRecord[]): OrderRecord[] {
  return input
    .filter((row) => row.orderCount > 0)
    .map((row) => ({ ...row, orderCount: Math.max(0, row.orderCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Prunes the payment side of a order, leaving the rest untouched. */
export function prunePayment(input: readonly OrderRecord[]): OrderRecord[] {
  return input
    .filter((row) => row.paymentCount > 0)
    .map((row) => ({ ...row, paymentCount: Math.max(0, row.paymentCount - 1) }))
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
  "invoice": 0,
  "order": 0,
  "payment": 0,
  "audit": 0,
  "threshold": 0,
  "quota": 0
};

export function withDefaults(partial: Partial<OrderRecord>): OrderRecord {
  return { id: '', state: 'invoice', updatedAt: '', ...DEFAULTS, ...partial } as OrderRecord;
}
