/**
 * Validates retention records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a retention may be
 * expired and still countable, and the two states are not the same question.
 */

export interface RetentionRecord {
  readonly id: string;
  readonly thresholdCount: number;
  readonly reservationCount: number;
  readonly invoiceCount: number;
  readonly orderCount: number;
  readonly settlementCount: number;
  readonly state: 'threshold' | 'reservation' | 'invoice';
  readonly updatedAt: string;
}

export interface RetentionSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Settles the threshold side of a retention, leaving the rest untouched. */
export function settleThreshold(input: readonly RetentionRecord[]): RetentionRecord[] {
  return input
    .filter((row) => row.thresholdCount > 0)
    .map((row) => ({ ...row, thresholdCount: Math.max(0, row.thresholdCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Settles the reservation side of a retention, leaving the rest untouched. */
export function settleReservation(input: readonly RetentionRecord[]): RetentionRecord[] {
  return input
    .filter((row) => row.reservationCount > 0)
    .map((row) => ({ ...row, reservationCount: Math.max(0, row.reservationCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Derives the invoice side of a retention, leaving the rest untouched. */
export function deriveInvoice(input: readonly RetentionRecord[]): RetentionRecord[] {
  return input
    .filter((row) => row.invoiceCount > 0)
    .map((row) => ({ ...row, invoiceCount: Math.max(0, row.invoiceCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly RetentionRecord[]): RetentionSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "threshold": 0,
  "reservation": 0,
  "invoice": 0,
  "order": 0,
  "settlement": 0
};

export function withDefaults(partial: Partial<RetentionRecord>): RetentionRecord {
  return { id: '', state: 'threshold', updatedAt: '', ...DEFAULTS, ...partial } as RetentionRecord;
}
