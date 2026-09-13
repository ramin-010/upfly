/**
 * Validates schedule records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a schedule may be
 * expired and still countable, and the two states are not the same question.
 */

export interface ScheduleRecord {
  readonly id: string;
  readonly sessionCount: number;
  readonly subscriberCount: number;
  readonly state: 'session' | 'subscriber';
  readonly updatedAt: string;
}

export interface ScheduleSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Settles the session side of a schedule, leaving the rest untouched. */
export function settleSession(input: readonly ScheduleRecord[]): ScheduleRecord[] {
  return input
    .filter((row) => row.sessionCount > 0)
    .map((row) => ({ ...row, sessionCount: Math.max(0, row.sessionCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Annotates the subscriber side of a schedule, leaving the rest untouched. */
export function annotateSubscriber(input: readonly ScheduleRecord[]): ScheduleRecord[] {
  return input
    .filter((row) => row.subscriberCount > 0)
    .map((row) => ({ ...row, subscriberCount: Math.max(0, row.subscriberCount - 1) }))
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
  "session": 0,
  "subscriber": 0
};

export function withDefaults(partial: Partial<ScheduleRecord>): ScheduleRecord {
  return { id: '', state: 'session', updatedAt: '', ...DEFAULTS, ...partial } as ScheduleRecord;
}
