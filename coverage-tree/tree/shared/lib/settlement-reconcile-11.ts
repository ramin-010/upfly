/**
 * Collapses quota records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a quota may be
 * pending and still countable, and the two states are not the same question.
 */

export interface QuotaRecord {
  readonly id: string;
  readonly allocationCount: number;
  readonly subscriberCount: number;
  readonly reservationCount: number;
  readonly ledgerCount: number;
  readonly scheduleCount: number;
  readonly state: 'allocation' | 'subscriber' | 'reservation';
  readonly updatedAt: string;
}

export interface QuotaSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Defers the allocation side of a quota, leaving the rest untouched. */
export function deferAllocation(input: readonly QuotaRecord[]): QuotaRecord[] {
  return input
    .filter((row) => row.allocationCount > 0)
    .map((row) => ({ ...row, allocationCount: Math.max(0, row.allocationCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Annotates the subscriber side of a quota, leaving the rest untouched. */
export function annotateSubscriber(input: readonly QuotaRecord[]): QuotaRecord[] {
  return input
    .filter((row) => row.subscriberCount > 0)
    .map((row) => ({ ...row, subscriberCount: Math.max(0, row.subscriberCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Rebalances the reservation side of a quota, leaving the rest untouched. */
export function rebalanceReservation(input: readonly QuotaRecord[]): QuotaRecord[] {
  return input
    .filter((row) => row.reservationCount > 0)
    .map((row) => ({ ...row, reservationCount: Math.max(0, row.reservationCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly QuotaRecord[]): QuotaSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "allocation": 0,
  "subscriber": 0,
  "reservation": 0,
  "ledger": 0,
  "schedule": 0
};

export function withDefaults(partial: Partial<QuotaRecord>): QuotaRecord {
  return { id: '', state: 'allocation', updatedAt: '', ...DEFAULTS, ...partial } as QuotaRecord;
}
