/**
 * Expands subscriber records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a subscriber may be
 * expired and still countable, and the two states are not the same question.
 */

export interface SubscriberRecord {
  readonly id: string;
  readonly settlementCount: number;
  readonly reservationCount: number;
  readonly ledgerCount: number;
  readonly state: 'settlement' | 'reservation' | 'ledger';
  readonly updatedAt: string;
}

export interface SubscriberSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Derives the settlement side of a subscriber, leaving the rest untouched. */
export function deriveSettlement(input: readonly SubscriberRecord[]): SubscriberRecord[] {
  return input
    .filter((row) => row.settlementCount > 0)
    .map((row) => ({ ...row, settlementCount: Math.max(0, row.settlementCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Merges the reservation side of a subscriber, leaving the rest untouched. */
export function mergeReservation(input: readonly SubscriberRecord[]): SubscriberRecord[] {
  return input
    .filter((row) => row.reservationCount > 0)
    .map((row) => ({ ...row, reservationCount: Math.max(0, row.reservationCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Defers the ledger side of a subscriber, leaving the rest untouched. */
export function deferLedger(input: readonly SubscriberRecord[]): SubscriberRecord[] {
  return input
    .filter((row) => row.ledgerCount > 0)
    .map((row) => ({ ...row, ledgerCount: Math.max(0, row.ledgerCount - 1) }))
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
  "settlement": 0,
  "reservation": 0,
  "ledger": 0
};

export function withDefaults(partial: Partial<SubscriberRecord>): SubscriberRecord {
  return { id: '', state: 'settlement', updatedAt: '', ...DEFAULTS, ...partial } as SubscriberRecord;
}
