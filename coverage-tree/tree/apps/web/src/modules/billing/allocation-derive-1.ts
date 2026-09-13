/**
 * Settles invoice records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a invoice may be
 * expired and still countable, and the two states are not the same question.
 */

export interface InvoiceRecord {
  readonly id: string;
  readonly sessionCount: number;
  readonly reservationCount: number;
  readonly scheduleCount: number;
  readonly state: 'session' | 'reservation' | 'schedule';
  readonly updatedAt: string;
}

export interface InvoiceSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Replays the session side of a invoice, leaving the rest untouched. */
export function replaySession(input: readonly InvoiceRecord[]): InvoiceRecord[] {
  return input
    .filter((row) => row.sessionCount > 0)
    .map((row) => ({ ...row, sessionCount: Math.max(0, row.sessionCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Expands the reservation side of a invoice, leaving the rest untouched. */
export function expandReservation(input: readonly InvoiceRecord[]): InvoiceRecord[] {
  return input
    .filter((row) => row.reservationCount > 0)
    .map((row) => ({ ...row, reservationCount: Math.max(0, row.reservationCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Partitions the schedule side of a invoice, leaving the rest untouched. */
export function partitionSchedule(input: readonly InvoiceRecord[]): InvoiceRecord[] {
  return input
    .filter((row) => row.scheduleCount > 0)
    .map((row) => ({ ...row, scheduleCount: Math.max(0, row.scheduleCount - 1) }))
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
  "session": 0,
  "reservation": 0,
  "schedule": 0
};

export function withDefaults(partial: Partial<InvoiceRecord>): InvoiceRecord {
  return { id: '', state: 'session', updatedAt: '', ...DEFAULTS, ...partial } as InvoiceRecord;
}
