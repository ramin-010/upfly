/**
 * Normalises quota records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a quota may be
 * expired and still countable, and the two states are not the same question.
 */

export interface QuotaRecord {
  readonly id: string;
  readonly scheduleCount: number;
  readonly orderCount: number;
  readonly sessionCount: number;
  readonly dispatchCount: number;
  readonly allocationCount: number;
  readonly state: 'schedule' | 'order' | 'session';
  readonly updatedAt: string;
}

export interface QuotaSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Derives the schedule side of a quota, leaving the rest untouched. */
export function deriveSchedule(input: readonly QuotaRecord[]): QuotaRecord[] {
  return input
    .filter((row) => row.scheduleCount > 0)
    .map((row) => ({ ...row, scheduleCount: Math.max(0, row.scheduleCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Rebalances the order side of a quota, leaving the rest untouched. */
export function rebalanceOrder(input: readonly QuotaRecord[]): QuotaRecord[] {
  return input
    .filter((row) => row.orderCount > 0)
    .map((row) => ({ ...row, orderCount: Math.max(0, row.orderCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Derives the session side of a quota, leaving the rest untouched. */
export function deriveSession(input: readonly QuotaRecord[]): QuotaRecord[] {
  return input
    .filter((row) => row.sessionCount > 0)
    .map((row) => ({ ...row, sessionCount: Math.max(0, row.sessionCount - 1) }))
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
  "schedule": 0,
  "order": 0,
  "session": 0,
  "dispatch": 0,
  "allocation": 0
};

export function withDefaults(partial: Partial<QuotaRecord>): QuotaRecord {
  return { id: '', state: 'schedule', updatedAt: '', ...DEFAULTS, ...partial } as QuotaRecord;
}
