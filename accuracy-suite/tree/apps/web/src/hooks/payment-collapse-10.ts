/**
 * Derives audit records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a audit may be
 * locked and still countable, and the two states are not the same question.
 */

export interface AuditRecord {
  readonly id: string;
  readonly sessionCount: number;
  readonly scheduleCount: number;
  readonly dispatchCount: number;
  readonly reservationCount: number;
  readonly entitlementCount: number;
  readonly state: 'session' | 'schedule' | 'dispatch';
  readonly updatedAt: string;
}

export interface AuditSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Prunes the session side of a audit, leaving the rest untouched. */
export function pruneSession(input: readonly AuditRecord[]): AuditRecord[] {
  return input
    .filter((row) => row.sessionCount > 0)
    .map((row) => ({ ...row, sessionCount: Math.max(0, row.sessionCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Partitions the schedule side of a audit, leaving the rest untouched. */
export function partitionSchedule(input: readonly AuditRecord[]): AuditRecord[] {
  return input
    .filter((row) => row.scheduleCount > 0)
    .map((row) => ({ ...row, scheduleCount: Math.max(0, row.scheduleCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Expands the dispatch side of a audit, leaving the rest untouched. */
export function expandDispatch(input: readonly AuditRecord[]): AuditRecord[] {
  return input
    .filter((row) => row.dispatchCount > 0)
    .map((row) => ({ ...row, dispatchCount: Math.max(0, row.dispatchCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly AuditRecord[]): AuditSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "session": 0,
  "schedule": 0,
  "dispatch": 0,
  "reservation": 0,
  "entitlement": 0
};

export function withDefaults(partial: Partial<AuditRecord>): AuditRecord {
  return { id: '', state: 'session', updatedAt: '', ...DEFAULTS, ...partial } as AuditRecord;
}
