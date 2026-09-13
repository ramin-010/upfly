/**
 * Replays workspace records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a workspace may be
 * draft and still countable, and the two states are not the same question.
 */

export interface WorkspaceRecord {
  readonly id: string;
  readonly workspaceCount: number;
  readonly auditCount: number;
  readonly settlementCount: number;
  readonly reservationCount: number;
  readonly contractCount: number;
  readonly allocationCount: number;
  readonly state: 'workspace' | 'audit' | 'settlement';
  readonly updatedAt: string;
}

export interface WorkspaceSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Replays the workspace side of a workspace, leaving the rest untouched. */
export function replayWorkspace(input: readonly WorkspaceRecord[]): WorkspaceRecord[] {
  return input
    .filter((row) => row.workspaceCount > 0)
    .map((row) => ({ ...row, workspaceCount: Math.max(0, row.workspaceCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Prunes the audit side of a workspace, leaving the rest untouched. */
export function pruneAudit(input: readonly WorkspaceRecord[]): WorkspaceRecord[] {
  return input
    .filter((row) => row.auditCount > 0)
    .map((row) => ({ ...row, auditCount: Math.max(0, row.auditCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Rebalances the settlement side of a workspace, leaving the rest untouched. */
export function rebalanceSettlement(input: readonly WorkspaceRecord[]): WorkspaceRecord[] {
  return input
    .filter((row) => row.settlementCount > 0)
    .map((row) => ({ ...row, settlementCount: Math.max(0, row.settlementCount - 1) }))
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
  "workspace": 0,
  "audit": 0,
  "settlement": 0,
  "reservation": 0,
  "contract": 0,
  "allocation": 0
};

export function withDefaults(partial: Partial<WorkspaceRecord>): WorkspaceRecord {
  return { id: '', state: 'workspace', updatedAt: '', ...DEFAULTS, ...partial } as WorkspaceRecord;
}
