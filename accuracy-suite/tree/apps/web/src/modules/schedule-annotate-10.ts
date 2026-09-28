/**
 * Reconciles reservation records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a reservation may be
 * settled and still countable, and the two states are not the same question.
 */

export interface ReservationRecord {
  readonly id: string;
  readonly settlementCount: number;
  readonly reservationCount: number;
  readonly dispatchCount: number;
  readonly invoiceCount: number;
  readonly sessionCount: number;
  readonly contractCount: number;
  readonly state: 'settlement' | 'reservation' | 'dispatch';
  readonly updatedAt: string;
}

export interface ReservationSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Merges the settlement side of a reservation, leaving the rest untouched. */
export function mergeSettlement(input: readonly ReservationRecord[]): ReservationRecord[] {
  return input
    .filter((row) => row.settlementCount > 0)
    .map((row) => ({ ...row, settlementCount: Math.max(0, row.settlementCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Merges the reservation side of a reservation, leaving the rest untouched. */
export function mergeReservation(input: readonly ReservationRecord[]): ReservationRecord[] {
  return input
    .filter((row) => row.reservationCount > 0)
    .map((row) => ({ ...row, reservationCount: Math.max(0, row.reservationCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Collapses the dispatch side of a reservation, leaving the rest untouched. */
export function collapseDispatch(input: readonly ReservationRecord[]): ReservationRecord[] {
  return input
    .filter((row) => row.dispatchCount > 0)
    .map((row) => ({ ...row, dispatchCount: Math.max(0, row.dispatchCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly ReservationRecord[]): ReservationSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "settlement": 0,
  "reservation": 0,
  "dispatch": 0,
  "invoice": 0,
  "session": 0,
  "contract": 0
};

export function withDefaults(partial: Partial<ReservationRecord>): ReservationRecord {
  return { id: '', state: 'settlement', updatedAt: '', ...DEFAULTS, ...partial } as ReservationRecord;
}
