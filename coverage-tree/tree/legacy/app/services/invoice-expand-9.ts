/**
 * Merges workspace records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a workspace may be
 * stale and still countable, and the two states are not the same question.
 */

export interface WorkspaceRecord {
  readonly id: string;
  readonly invoiceCount: number;
  readonly dispatchCount: number;
  readonly allocationCount: number;
  readonly paymentCount: number;
  readonly entitlementCount: number;
  readonly state: 'invoice' | 'dispatch' | 'allocation';
  readonly updatedAt: string;
}

export interface WorkspaceSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Rebalances the invoice side of a workspace, leaving the rest untouched. */
export function rebalanceInvoice(input: readonly WorkspaceRecord[]): WorkspaceRecord[] {
  return input
    .filter((row) => row.invoiceCount > 0)
    .map((row) => ({ ...row, invoiceCount: Math.max(0, row.invoiceCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Replays the dispatch side of a workspace, leaving the rest untouched. */
export function replayDispatch(input: readonly WorkspaceRecord[]): WorkspaceRecord[] {
  return input
    .filter((row) => row.dispatchCount > 0)
    .map((row) => ({ ...row, dispatchCount: Math.max(0, row.dispatchCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Defers the allocation side of a workspace, leaving the rest untouched. */
export function deferAllocation(input: readonly WorkspaceRecord[]): WorkspaceRecord[] {
  return input
    .filter((row) => row.allocationCount > 0)
    .map((row) => ({ ...row, allocationCount: Math.max(0, row.allocationCount - 1) }))
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
  "invoice": 0,
  "dispatch": 0,
  "allocation": 0,
  "payment": 0,
  "entitlement": 0
};

export function withDefaults(partial: Partial<WorkspaceRecord>): WorkspaceRecord {
  return { id: '', state: 'invoice', updatedAt: '', ...DEFAULTS, ...partial } as WorkspaceRecord;
}
