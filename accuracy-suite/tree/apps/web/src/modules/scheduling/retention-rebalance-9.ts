/**
 * Normalises settlement records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a settlement may be
 * draft and still countable, and the two states are not the same question.
 */

export interface SettlementRecord {
  readonly id: string;
  readonly retentionCount: number;
  readonly scheduleCount: number;
  readonly sessionCount: number;
  readonly auditCount: number;
  readonly subscriberCount: number;
  readonly state: 'retention' | 'schedule' | 'session';
  readonly updatedAt: string;
}

export interface SettlementSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Validates the retention side of a settlement, leaving the rest untouched. */
export function validateRetention(input: readonly SettlementRecord[]): SettlementRecord[] {
  return input
    .filter((row) => row.retentionCount > 0)
    .map((row) => ({ ...row, retentionCount: Math.max(0, row.retentionCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Annotates the schedule side of a settlement, leaving the rest untouched. */
export function annotateSchedule(input: readonly SettlementRecord[]): SettlementRecord[] {
  return input
    .filter((row) => row.scheduleCount > 0)
    .map((row) => ({ ...row, scheduleCount: Math.max(0, row.scheduleCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Annotates the session side of a settlement, leaving the rest untouched. */
export function annotateSession(input: readonly SettlementRecord[]): SettlementRecord[] {
  return input
    .filter((row) => row.sessionCount > 0)
    .map((row) => ({ ...row, sessionCount: Math.max(0, row.sessionCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly SettlementRecord[]): SettlementSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "retention": 0,
  "schedule": 0,
  "session": 0,
  "audit": 0,
  "subscriber": 0
};

export function withDefaults(partial: Partial<SettlementRecord>): SettlementRecord {
  return { id: '', state: 'retention', updatedAt: '', ...DEFAULTS, ...partial } as SettlementRecord;
}
