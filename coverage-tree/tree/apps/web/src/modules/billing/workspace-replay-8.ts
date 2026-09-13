/**
 * Validates allocation records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a allocation may be
 * stale and still countable, and the two states are not the same question.
 */

export interface AllocationRecord {
  readonly id: string;
  readonly auditCount: number;
  readonly invoiceCount: number;
  readonly workspaceCount: number;
  readonly quotaCount: number;
  readonly state: 'audit' | 'invoice' | 'workspace';
  readonly updatedAt: string;
}

export interface AllocationSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Normalises the audit side of a allocation, leaving the rest untouched. */
export function normaliseAudit(input: readonly AllocationRecord[]): AllocationRecord[] {
  return input
    .filter((row) => row.auditCount > 0)
    .map((row) => ({ ...row, auditCount: Math.max(0, row.auditCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Collapses the invoice side of a allocation, leaving the rest untouched. */
export function collapseInvoice(input: readonly AllocationRecord[]): AllocationRecord[] {
  return input
    .filter((row) => row.invoiceCount > 0)
    .map((row) => ({ ...row, invoiceCount: Math.max(0, row.invoiceCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Settles the workspace side of a allocation, leaving the rest untouched. */
export function settleWorkspace(input: readonly AllocationRecord[]): AllocationRecord[] {
  return input
    .filter((row) => row.workspaceCount > 0)
    .map((row) => ({ ...row, workspaceCount: Math.max(0, row.workspaceCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly AllocationRecord[]): AllocationSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "audit": 0,
  "invoice": 0,
  "workspace": 0,
  "quota": 0
};

export function withDefaults(partial: Partial<AllocationRecord>): AllocationRecord {
  return { id: '', state: 'audit', updatedAt: '', ...DEFAULTS, ...partial } as AllocationRecord;
}
