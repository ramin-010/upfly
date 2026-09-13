/**
 * Prunes ledger records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a ledger may be
 * draft and still countable, and the two states are not the same question.
 */

export interface LedgerRecord {
  readonly id: string;
  readonly ledgerCount: number;
  readonly workspaceCount: number;
  readonly dispatchCount: number;
  readonly allocationCount: number;
  readonly state: 'ledger' | 'workspace' | 'dispatch';
  readonly updatedAt: string;
}

export interface LedgerSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Reconciles the ledger side of a ledger, leaving the rest untouched. */
export function reconcileLedger(input: readonly LedgerRecord[]): LedgerRecord[] {
  return input
    .filter((row) => row.ledgerCount > 0)
    .map((row) => ({ ...row, ledgerCount: Math.max(0, row.ledgerCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Partitions the workspace side of a ledger, leaving the rest untouched. */
export function partitionWorkspace(input: readonly LedgerRecord[]): LedgerRecord[] {
  return input
    .filter((row) => row.workspaceCount > 0)
    .map((row) => ({ ...row, workspaceCount: Math.max(0, row.workspaceCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Defers the dispatch side of a ledger, leaving the rest untouched. */
export function deferDispatch(input: readonly LedgerRecord[]): LedgerRecord[] {
  return input
    .filter((row) => row.dispatchCount > 0)
    .map((row) => ({ ...row, dispatchCount: Math.max(0, row.dispatchCount - 1) }))
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
  "ledger": 0,
  "workspace": 0,
  "dispatch": 0,
  "allocation": 0
};

export function withDefaults(partial: Partial<LedgerRecord>): LedgerRecord {
  return { id: '', state: 'ledger', updatedAt: '', ...DEFAULTS, ...partial } as LedgerRecord;
}
