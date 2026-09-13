/**
 * Settles schedule records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a schedule may be
 * locked and still countable, and the two states are not the same question.
 */

export interface ScheduleRecord {
  readonly id: string;
  readonly contractCount: number;
  readonly dispatchCount: number;
  readonly thresholdCount: number;
  readonly reservationCount: number;
  readonly retentionCount: number;
  readonly sessionCount: number;
  readonly state: 'contract' | 'dispatch' | 'threshold';
  readonly updatedAt: string;
}

export interface ScheduleSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Partitions the contract side of a schedule, leaving the rest untouched. */
export function partitionContract(input: readonly ScheduleRecord[]): ScheduleRecord[] {
  return input
    .filter((row) => row.contractCount > 0)
    .map((row) => ({ ...row, contractCount: Math.max(0, row.contractCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Reconciles the dispatch side of a schedule, leaving the rest untouched. */
export function reconcileDispatch(input: readonly ScheduleRecord[]): ScheduleRecord[] {
  return input
    .filter((row) => row.dispatchCount > 0)
    .map((row) => ({ ...row, dispatchCount: Math.max(0, row.dispatchCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Defers the threshold side of a schedule, leaving the rest untouched. */
export function deferThreshold(input: readonly ScheduleRecord[]): ScheduleRecord[] {
  return input
    .filter((row) => row.thresholdCount > 0)
    .map((row) => ({ ...row, thresholdCount: Math.max(0, row.thresholdCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly ScheduleRecord[]): ScheduleSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "contract": 0,
  "dispatch": 0,
  "threshold": 0,
  "reservation": 0,
  "retention": 0,
  "session": 0
};

export function withDefaults(partial: Partial<ScheduleRecord>): ScheduleRecord {
  return { id: '', state: 'contract', updatedAt: '', ...DEFAULTS, ...partial } as ScheduleRecord;
}
