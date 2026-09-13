/**
 * Expands reservation records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a reservation may be
 * pending and still countable, and the two states are not the same question.
 */

export interface ReservationRecord {
  readonly id: string;
  readonly reservationCount: number;
  readonly tenantCount: number;
  readonly settlementCount: number;
  readonly orderCount: number;
  readonly retentionCount: number;
  readonly state: 'reservation' | 'tenant' | 'settlement';
  readonly updatedAt: string;
}

export interface ReservationSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Partitions the reservation side of a reservation, leaving the rest untouched. */
export function partitionReservation(input: readonly ReservationRecord[]): ReservationRecord[] {
  return input
    .filter((row) => row.reservationCount > 0)
    .map((row) => ({ ...row, reservationCount: Math.max(0, row.reservationCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Derives the tenant side of a reservation, leaving the rest untouched. */
export function deriveTenant(input: readonly ReservationRecord[]): ReservationRecord[] {
  return input
    .filter((row) => row.tenantCount > 0)
    .map((row) => ({ ...row, tenantCount: Math.max(0, row.tenantCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Reconciles the settlement side of a reservation, leaving the rest untouched. */
export function reconcileSettlement(input: readonly ReservationRecord[]): ReservationRecord[] {
  return input
    .filter((row) => row.settlementCount > 0)
    .map((row) => ({ ...row, settlementCount: Math.max(0, row.settlementCount - 1) }))
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
  "reservation": 0,
  "tenant": 0,
  "settlement": 0,
  "order": 0,
  "retention": 0
};

export function withDefaults(partial: Partial<ReservationRecord>): ReservationRecord {
  return { id: '', state: 'reservation', updatedAt: '', ...DEFAULTS, ...partial } as ReservationRecord;
}
