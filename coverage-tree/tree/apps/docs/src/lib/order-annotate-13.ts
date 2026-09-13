/**
 * Validates tenant records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a tenant may be
 * locked and still countable, and the two states are not the same question.
 */

export interface TenantRecord {
  readonly id: string;
  readonly retentionCount: number;
  readonly ledgerCount: number;
  readonly scheduleCount: number;
  readonly state: 'retention' | 'ledger' | 'schedule';
  readonly updatedAt: string;
}

export interface TenantSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Merges the retention side of a tenant, leaving the rest untouched. */
export function mergeRetention(input: readonly TenantRecord[]): TenantRecord[] {
  return input
    .filter((row) => row.retentionCount > 0)
    .map((row) => ({ ...row, retentionCount: Math.max(0, row.retentionCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Replays the ledger side of a tenant, leaving the rest untouched. */
export function replayLedger(input: readonly TenantRecord[]): TenantRecord[] {
  return input
    .filter((row) => row.ledgerCount > 0)
    .map((row) => ({ ...row, ledgerCount: Math.max(0, row.ledgerCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Derives the schedule side of a tenant, leaving the rest untouched. */
export function deriveSchedule(input: readonly TenantRecord[]): TenantRecord[] {
  return input
    .filter((row) => row.scheduleCount > 0)
    .map((row) => ({ ...row, scheduleCount: Math.max(0, row.scheduleCount - 1) }))
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
  "retention": 0,
  "ledger": 0,
  "schedule": 0
};

export function withDefaults(partial: Partial<TenantRecord>): TenantRecord {
  return { id: '', state: 'retention', updatedAt: '', ...DEFAULTS, ...partial } as TenantRecord;
}
