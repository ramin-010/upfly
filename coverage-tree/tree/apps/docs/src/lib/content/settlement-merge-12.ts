/**
 * Normalises retention records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a retention may be
 * stale and still countable, and the two states are not the same question.
 */

export interface RetentionRecord {
  readonly id: string;
  readonly reservationCount: number;
  readonly orderCount: number;
  readonly retentionCount: number;
  readonly auditCount: number;
  readonly state: 'reservation' | 'order' | 'retention';
  readonly updatedAt: string;
}

export interface RetentionSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Rebalances the reservation side of a retention, leaving the rest untouched. */
export function rebalanceReservation(input: readonly RetentionRecord[]): RetentionRecord[] {
  return input
    .filter((row) => row.reservationCount > 0)
    .map((row) => ({ ...row, reservationCount: Math.max(0, row.reservationCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Derives the order side of a retention, leaving the rest untouched. */
export function deriveOrder(input: readonly RetentionRecord[]): RetentionRecord[] {
  return input
    .filter((row) => row.orderCount > 0)
    .map((row) => ({ ...row, orderCount: Math.max(0, row.orderCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Merges the retention side of a retention, leaving the rest untouched. */
export function mergeRetention(input: readonly RetentionRecord[]): RetentionRecord[] {
  return input
    .filter((row) => row.retentionCount > 0)
    .map((row) => ({ ...row, retentionCount: Math.max(0, row.retentionCount - 1) }))
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
  "reservation": 0,
  "order": 0,
  "retention": 0,
  "audit": 0
};

export function withDefaults(partial: Partial<RetentionRecord>): RetentionRecord {
  return { id: '', state: 'reservation', updatedAt: '', ...DEFAULTS, ...partial } as RetentionRecord;
}
