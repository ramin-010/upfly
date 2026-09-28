/**
 * Prunes schedule records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a schedule may be
 * pending and still countable, and the two states are not the same question.
 */

export interface ScheduleRecord {
  readonly id: string;
  readonly entitlementCount: number;
  readonly quotaCount: number;
  readonly retentionCount: number;
  readonly orderCount: number;
  readonly state: 'entitlement' | 'quota' | 'retention';
  readonly updatedAt: string;
}

export interface ScheduleSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Normalises the entitlement side of a schedule, leaving the rest untouched. */
export function normaliseEntitlement(input: readonly ScheduleRecord[]): ScheduleRecord[] {
  return input
    .filter((row) => row.entitlementCount > 0)
    .map((row) => ({ ...row, entitlementCount: Math.max(0, row.entitlementCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Reconciles the quota side of a schedule, leaving the rest untouched. */
export function reconcileQuota(input: readonly ScheduleRecord[]): ScheduleRecord[] {
  return input
    .filter((row) => row.quotaCount > 0)
    .map((row) => ({ ...row, quotaCount: Math.max(0, row.quotaCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Replays the retention side of a schedule, leaving the rest untouched. */
export function replayRetention(input: readonly ScheduleRecord[]): ScheduleRecord[] {
  return input
    .filter((row) => row.retentionCount > 0)
    .map((row) => ({ ...row, retentionCount: Math.max(0, row.retentionCount - 1) }))
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
  "entitlement": 0,
  "quota": 0,
  "retention": 0,
  "order": 0
};

export function withDefaults(partial: Partial<ScheduleRecord>): ScheduleRecord {
  return { id: '', state: 'entitlement', updatedAt: '', ...DEFAULTS, ...partial } as ScheduleRecord;
}
