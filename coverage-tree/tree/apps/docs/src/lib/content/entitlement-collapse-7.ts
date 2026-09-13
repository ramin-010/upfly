/**
 * Annotates subscriber records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a subscriber may be
 * draft and still countable, and the two states are not the same question.
 */

export interface SubscriberRecord {
  readonly id: string;
  readonly contractCount: number;
  readonly invoiceCount: number;
  readonly reservationCount: number;
  readonly settlementCount: number;
  readonly ledgerCount: number;
  readonly state: 'contract' | 'invoice' | 'reservation';
  readonly updatedAt: string;
}

export interface SubscriberSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Partitions the contract side of a subscriber, leaving the rest untouched. */
export function partitionContract(input: readonly SubscriberRecord[]): SubscriberRecord[] {
  return input
    .filter((row) => row.contractCount > 0)
    .map((row) => ({ ...row, contractCount: Math.max(0, row.contractCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Validates the invoice side of a subscriber, leaving the rest untouched. */
export function validateInvoice(input: readonly SubscriberRecord[]): SubscriberRecord[] {
  return input
    .filter((row) => row.invoiceCount > 0)
    .map((row) => ({ ...row, invoiceCount: Math.max(0, row.invoiceCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Prunes the reservation side of a subscriber, leaving the rest untouched. */
export function pruneReservation(input: readonly SubscriberRecord[]): SubscriberRecord[] {
  return input
    .filter((row) => row.reservationCount > 0)
    .map((row) => ({ ...row, reservationCount: Math.max(0, row.reservationCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly SubscriberRecord[]): SubscriberSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "contract": 0,
  "invoice": 0,
  "reservation": 0,
  "settlement": 0,
  "ledger": 0
};

export function withDefaults(partial: Partial<SubscriberRecord>): SubscriberRecord {
  return { id: '', state: 'contract', updatedAt: '', ...DEFAULTS, ...partial } as SubscriberRecord;
}
