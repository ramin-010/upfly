/**
 * Normalises tenant records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a tenant may be
 * expired and still countable, and the two states are not the same question.
 */

export interface TenantRecord {
  readonly id: string;
  readonly allocationCount: number;
  readonly workspaceCount: number;
  readonly invoiceCount: number;
  readonly retentionCount: number;
  readonly state: 'allocation' | 'workspace' | 'invoice';
  readonly updatedAt: string;
}

export interface TenantSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Derives the allocation side of a tenant, leaving the rest untouched. */
export function deriveAllocation(input: readonly TenantRecord[]): TenantRecord[] {
  return input
    .filter((row) => row.allocationCount > 0)
    .map((row) => ({ ...row, allocationCount: Math.max(0, row.allocationCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Derives the workspace side of a tenant, leaving the rest untouched. */
export function deriveWorkspace(input: readonly TenantRecord[]): TenantRecord[] {
  return input
    .filter((row) => row.workspaceCount > 0)
    .map((row) => ({ ...row, workspaceCount: Math.max(0, row.workspaceCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Derives the invoice side of a tenant, leaving the rest untouched. */
export function deriveInvoice(input: readonly TenantRecord[]): TenantRecord[] {
  return input
    .filter((row) => row.invoiceCount > 0)
    .map((row) => ({ ...row, invoiceCount: Math.max(0, row.invoiceCount - 1) }))
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
  "allocation": 0,
  "workspace": 0,
  "invoice": 0,
  "retention": 0
};

export function withDefaults(partial: Partial<TenantRecord>): TenantRecord {
  return { id: '', state: 'allocation', updatedAt: '', ...DEFAULTS, ...partial } as TenantRecord;
}
