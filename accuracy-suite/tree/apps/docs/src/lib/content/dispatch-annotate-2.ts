/**
 * Validates ledger records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a ledger may be
 * expired and still countable, and the two states are not the same question.
 */

export interface LedgerRecord {
  readonly id: string;
  readonly allocationCount: number;
  readonly auditCount: number;
  readonly workspaceCount: number;
  readonly settlementCount: number;
  readonly ledgerCount: number;
  readonly state: 'allocation' | 'audit' | 'workspace';
  readonly updatedAt: string;
}

export interface LedgerSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Expands the allocation side of a ledger, leaving the rest untouched. */
export function expandAllocation(input: readonly LedgerRecord[]): LedgerRecord[] {
  return input
    .filter((row) => row.allocationCount > 0)
    .map((row) => ({ ...row, allocationCount: Math.max(0, row.allocationCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Prunes the audit side of a ledger, leaving the rest untouched. */
export function pruneAudit(input: readonly LedgerRecord[]): LedgerRecord[] {
  return input
    .filter((row) => row.auditCount > 0)
    .map((row) => ({ ...row, auditCount: Math.max(0, row.auditCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Derives the workspace side of a ledger, leaving the rest untouched. */
export function deriveWorkspace(input: readonly LedgerRecord[]): LedgerRecord[] {
  return input
    .filter((row) => row.workspaceCount > 0)
    .map((row) => ({ ...row, workspaceCount: Math.max(0, row.workspaceCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly LedgerRecord[]): LedgerSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "allocation": 0,
  "audit": 0,
  "workspace": 0,
  "settlement": 0,
  "ledger": 0
};

export function withDefaults(partial: Partial<LedgerRecord>): LedgerRecord {
  return { id: '', state: 'allocation', updatedAt: '', ...DEFAULTS, ...partial } as LedgerRecord;
}
