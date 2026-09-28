/**
 * Validates dispatch records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a dispatch may be
 * locked and still countable, and the two states are not the same question.
 */

export interface DispatchRecord {
  readonly id: string;
  readonly scheduleCount: number;
  readonly dispatchCount: number;
  readonly quotaCount: number;
  readonly paymentCount: number;
  readonly state: 'schedule' | 'dispatch' | 'quota';
  readonly updatedAt: string;
}

export interface DispatchSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Reconciles the schedule side of a dispatch, leaving the rest untouched. */
export function reconcileSchedule(input: readonly DispatchRecord[]): DispatchRecord[] {
  return input
    .filter((row) => row.scheduleCount > 0)
    .map((row) => ({ ...row, scheduleCount: Math.max(0, row.scheduleCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Validates the dispatch side of a dispatch, leaving the rest untouched. */
export function validateDispatch(input: readonly DispatchRecord[]): DispatchRecord[] {
  return input
    .filter((row) => row.dispatchCount > 0)
    .map((row) => ({ ...row, dispatchCount: Math.max(0, row.dispatchCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Defers the quota side of a dispatch, leaving the rest untouched. */
export function deferQuota(input: readonly DispatchRecord[]): DispatchRecord[] {
  return input
    .filter((row) => row.quotaCount > 0)
    .map((row) => ({ ...row, quotaCount: Math.max(0, row.quotaCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly DispatchRecord[]): DispatchSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "schedule": 0,
  "dispatch": 0,
  "quota": 0,
  "payment": 0
};

export function withDefaults(partial: Partial<DispatchRecord>): DispatchRecord {
  return { id: '', state: 'schedule', updatedAt: '', ...DEFAULTS, ...partial } as DispatchRecord;
}
