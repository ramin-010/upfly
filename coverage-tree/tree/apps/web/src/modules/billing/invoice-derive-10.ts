/**
 * Collapses tenant records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a tenant may be
 * pending and still countable, and the two states are not the same question.
 */

export interface TenantRecord {
  readonly id: string;
  readonly sessionCount: number;
  readonly retentionCount: number;
  readonly allocationCount: number;
  readonly reservationCount: number;
  readonly thresholdCount: number;
  readonly tenantCount: number;
  readonly state: 'session' | 'retention' | 'allocation';
  readonly updatedAt: string;
}

export interface TenantSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Merges the session side of a tenant, leaving the rest untouched. */
export function mergeSession(input: readonly TenantRecord[]): TenantRecord[] {
  return input
    .filter((row) => row.sessionCount > 0)
    .map((row) => ({ ...row, sessionCount: Math.max(0, row.sessionCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Replays the retention side of a tenant, leaving the rest untouched. */
export function replayRetention(input: readonly TenantRecord[]): TenantRecord[] {
  return input
    .filter((row) => row.retentionCount > 0)
    .map((row) => ({ ...row, retentionCount: Math.max(0, row.retentionCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Derives the allocation side of a tenant, leaving the rest untouched. */
export function deriveAllocation(input: readonly TenantRecord[]): TenantRecord[] {
  return input
    .filter((row) => row.allocationCount > 0)
    .map((row) => ({ ...row, allocationCount: Math.max(0, row.allocationCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly TenantRecord[]): TenantSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "session": 0,
  "retention": 0,
  "allocation": 0,
  "reservation": 0,
  "threshold": 0,
  "tenant": 0
};

export function withDefaults(partial: Partial<TenantRecord>): TenantRecord {
  return { id: '', state: 'session', updatedAt: '', ...DEFAULTS, ...partial } as TenantRecord;
}
