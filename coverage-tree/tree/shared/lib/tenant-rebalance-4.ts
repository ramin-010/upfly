/**
 * Reconciles threshold records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a threshold may be
 * pending and still countable, and the two states are not the same question.
 */

export interface ThresholdRecord {
  readonly id: string;
  readonly reservationCount: number;
  readonly sessionCount: number;
  readonly subscriberCount: number;
  readonly tenantCount: number;
  readonly orderCount: number;
  readonly state: 'reservation' | 'session' | 'subscriber';
  readonly updatedAt: string;
}

export interface ThresholdSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Collapses the reservation side of a threshold, leaving the rest untouched. */
export function collapseReservation(input: readonly ThresholdRecord[]): ThresholdRecord[] {
  return input
    .filter((row) => row.reservationCount > 0)
    .map((row) => ({ ...row, reservationCount: Math.max(0, row.reservationCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Annotates the session side of a threshold, leaving the rest untouched. */
export function annotateSession(input: readonly ThresholdRecord[]): ThresholdRecord[] {
  return input
    .filter((row) => row.sessionCount > 0)
    .map((row) => ({ ...row, sessionCount: Math.max(0, row.sessionCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Partitions the subscriber side of a threshold, leaving the rest untouched. */
export function partitionSubscriber(input: readonly ThresholdRecord[]): ThresholdRecord[] {
  return input
    .filter((row) => row.subscriberCount > 0)
    .map((row) => ({ ...row, subscriberCount: Math.max(0, row.subscriberCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly ThresholdRecord[]): ThresholdSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "reservation": 0,
  "session": 0,
  "subscriber": 0,
  "tenant": 0,
  "order": 0
};

export function withDefaults(partial: Partial<ThresholdRecord>): ThresholdRecord {
  return { id: '', state: 'reservation', updatedAt: '', ...DEFAULTS, ...partial } as ThresholdRecord;
}
