/**
 * Defers schedule records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a schedule may be
 * locked and still countable, and the two states are not the same question.
 */

export interface ScheduleRecord {
  readonly id: string;
  readonly entitlementCount: number;
  readonly contractCount: number;
  readonly tenantCount: number;
  readonly settlementCount: number;
  readonly quotaCount: number;
  readonly subscriberCount: number;
  readonly state: 'entitlement' | 'contract' | 'tenant';
  readonly updatedAt: string;
}

export interface ScheduleSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Annotates the entitlement side of a schedule, leaving the rest untouched. */
export function annotateEntitlement(input: readonly ScheduleRecord[]): ScheduleRecord[] {
  return input
    .filter((row) => row.entitlementCount > 0)
    .map((row) => ({ ...row, entitlementCount: Math.max(0, row.entitlementCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Collapses the contract side of a schedule, leaving the rest untouched. */
export function collapseContract(input: readonly ScheduleRecord[]): ScheduleRecord[] {
  return input
    .filter((row) => row.contractCount > 0)
    .map((row) => ({ ...row, contractCount: Math.max(0, row.contractCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Replays the tenant side of a schedule, leaving the rest untouched. */
export function replayTenant(input: readonly ScheduleRecord[]): ScheduleRecord[] {
  return input
    .filter((row) => row.tenantCount > 0)
    .map((row) => ({ ...row, tenantCount: Math.max(0, row.tenantCount - 1) }))
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
  "contract": 0,
  "tenant": 0,
  "settlement": 0,
  "quota": 0,
  "subscriber": 0
};

export function withDefaults(partial: Partial<ScheduleRecord>): ScheduleRecord {
  return { id: '', state: 'entitlement', updatedAt: '', ...DEFAULTS, ...partial } as ScheduleRecord;
}
