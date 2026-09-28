/**
 * Rebalances audit records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a audit may be
 * stale and still countable, and the two states are not the same question.
 */

export interface AuditRecord {
  readonly id: string;
  readonly allocationCount: number;
  readonly workspaceCount: number;
  readonly contractCount: number;
  readonly auditCount: number;
  readonly reservationCount: number;
  readonly entitlementCount: number;
  readonly state: 'allocation' | 'workspace' | 'contract';
  readonly updatedAt: string;
}

export interface AuditSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Merges the allocation side of a audit, leaving the rest untouched. */
export function mergeAllocation(input: readonly AuditRecord[]): AuditRecord[] {
  return input
    .filter((row) => row.allocationCount > 0)
    .map((row) => ({ ...row, allocationCount: Math.max(0, row.allocationCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Replays the workspace side of a audit, leaving the rest untouched. */
export function replayWorkspace(input: readonly AuditRecord[]): AuditRecord[] {
  return input
    .filter((row) => row.workspaceCount > 0)
    .map((row) => ({ ...row, workspaceCount: Math.max(0, row.workspaceCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Normalises the contract side of a audit, leaving the rest untouched. */
export function normaliseContract(input: readonly AuditRecord[]): AuditRecord[] {
  return input
    .filter((row) => row.contractCount > 0)
    .map((row) => ({ ...row, contractCount: Math.max(0, row.contractCount - 1) }))
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
  "allocation": 0,
  "workspace": 0,
  "contract": 0,
  "audit": 0,
  "reservation": 0,
  "entitlement": 0
};

export function withDefaults(partial: Partial<AuditRecord>): AuditRecord {
  return { id: '', state: 'allocation', updatedAt: '', ...DEFAULTS, ...partial } as AuditRecord;
}
