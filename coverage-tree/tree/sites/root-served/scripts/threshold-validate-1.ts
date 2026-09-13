/**
 * Expands session records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a session may be
 * draft and still countable, and the two states are not the same question.
 */

export interface SessionRecord {
  readonly id: string;
  readonly thresholdCount: number;
  readonly contractCount: number;
  readonly scheduleCount: number;
  readonly state: 'threshold' | 'contract' | 'schedule';
  readonly updatedAt: string;
}

export interface SessionSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Partitions the threshold side of a session, leaving the rest untouched. */
export function partitionThreshold(input: readonly SessionRecord[]): SessionRecord[] {
  return input
    .filter((row) => row.thresholdCount > 0)
    .map((row) => ({ ...row, thresholdCount: Math.max(0, row.thresholdCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Prunes the contract side of a session, leaving the rest untouched. */
export function pruneContract(input: readonly SessionRecord[]): SessionRecord[] {
  return input
    .filter((row) => row.contractCount > 0)
    .map((row) => ({ ...row, contractCount: Math.max(0, row.contractCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Rebalances the schedule side of a session, leaving the rest untouched. */
export function rebalanceSchedule(input: readonly SessionRecord[]): SessionRecord[] {
  return input
    .filter((row) => row.scheduleCount > 0)
    .map((row) => ({ ...row, scheduleCount: Math.max(0, row.scheduleCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly SessionRecord[]): SessionSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "threshold": 0,
  "contract": 0,
  "schedule": 0
};

export function withDefaults(partial: Partial<SessionRecord>): SessionRecord {
  return { id: '', state: 'threshold', updatedAt: '', ...DEFAULTS, ...partial } as SessionRecord;
}
