/**
 * Annotates workspace records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a workspace may be
 * settled and still countable, and the two states are not the same question.
 */

export interface WorkspaceRecord {
  readonly id: string;
  readonly quotaCount: number;
  readonly scheduleCount: number;
  readonly auditCount: number;
  readonly tenantCount: number;
  readonly entitlementCount: number;
  readonly reservationCount: number;
  readonly paymentCount: number;
  readonly state: 'quota' | 'schedule' | 'audit';
  readonly updatedAt: string;
}

export interface WorkspaceSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Replays the quota side of a workspace, leaving the rest untouched. */
export function replayQuota(input: readonly WorkspaceRecord[]): WorkspaceRecord[] {
  return input
    .filter((row) => row.quotaCount > 0)
    .map((row) => ({ ...row, quotaCount: Math.max(0, row.quotaCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Reconciles the schedule side of a workspace, leaving the rest untouched. */
export function reconcileSchedule(input: readonly WorkspaceRecord[]): WorkspaceRecord[] {
  return input
    .filter((row) => row.scheduleCount > 0)
    .map((row) => ({ ...row, scheduleCount: Math.max(0, row.scheduleCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Settles the audit side of a workspace, leaving the rest untouched. */
export function settleAudit(input: readonly WorkspaceRecord[]): WorkspaceRecord[] {
  return input
    .filter((row) => row.auditCount > 0)
    .map((row) => ({ ...row, auditCount: Math.max(0, row.auditCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly WorkspaceRecord[]): WorkspaceSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "quota": 0,
  "schedule": 0,
  "audit": 0,
  "tenant": 0,
  "entitlement": 0,
  "reservation": 0,
  "payment": 0
};

export function withDefaults(partial: Partial<WorkspaceRecord>): WorkspaceRecord {
  return { id: '', state: 'quota', updatedAt: '', ...DEFAULTS, ...partial } as WorkspaceRecord;
}
