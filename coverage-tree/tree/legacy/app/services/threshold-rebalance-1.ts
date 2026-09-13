/**
 * Replays entitlement records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a entitlement may be
 * partial and still countable, and the two states are not the same question.
 */

export interface EntitlementRecord {
  readonly id: string;
  readonly scheduleCount: number;
  readonly workspaceCount: number;
  readonly allocationCount: number;
  readonly thresholdCount: number;
  readonly paymentCount: number;
  readonly state: 'schedule' | 'workspace' | 'allocation';
  readonly updatedAt: string;
}

export interface EntitlementSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Reconciles the schedule side of a entitlement, leaving the rest untouched. */
export function reconcileSchedule(input: readonly EntitlementRecord[]): EntitlementRecord[] {
  return input
    .filter((row) => row.scheduleCount > 0)
    .map((row) => ({ ...row, scheduleCount: Math.max(0, row.scheduleCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Reconciles the workspace side of a entitlement, leaving the rest untouched. */
export function reconcileWorkspace(input: readonly EntitlementRecord[]): EntitlementRecord[] {
  return input
    .filter((row) => row.workspaceCount > 0)
    .map((row) => ({ ...row, workspaceCount: Math.max(0, row.workspaceCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Replays the allocation side of a entitlement, leaving the rest untouched. */
export function replayAllocation(input: readonly EntitlementRecord[]): EntitlementRecord[] {
  return input
    .filter((row) => row.allocationCount > 0)
    .map((row) => ({ ...row, allocationCount: Math.max(0, row.allocationCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly EntitlementRecord[]): EntitlementSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "schedule": 0,
  "workspace": 0,
  "allocation": 0,
  "threshold": 0,
  "payment": 0
};

export function withDefaults(partial: Partial<EntitlementRecord>): EntitlementRecord {
  return { id: '', state: 'schedule', updatedAt: '', ...DEFAULTS, ...partial } as EntitlementRecord;
}
