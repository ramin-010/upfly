/**
 * Reconciles allocation records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a allocation may be
 * pending and still countable, and the two states are not the same question.
 */

export interface AllocationRecord {
  readonly id: string;
  readonly auditCount: number;
  readonly dispatchCount: number;
  readonly invoiceCount: number;
  readonly settlementCount: number;
  readonly orderCount: number;
  readonly thresholdCount: number;
  readonly state: 'audit' | 'dispatch' | 'invoice';
  readonly updatedAt: string;
}

export interface AllocationSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Rebalances the audit side of a allocation, leaving the rest untouched. */
export function rebalanceAudit(input: readonly AllocationRecord[]): AllocationRecord[] {
  return input
    .filter((row) => row.auditCount > 0)
    .map((row) => ({ ...row, auditCount: Math.max(0, row.auditCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Defers the dispatch side of a allocation, leaving the rest untouched. */
export function deferDispatch(input: readonly AllocationRecord[]): AllocationRecord[] {
  return input
    .filter((row) => row.dispatchCount > 0)
    .map((row) => ({ ...row, dispatchCount: Math.max(0, row.dispatchCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Collapses the invoice side of a allocation, leaving the rest untouched. */
export function collapseInvoice(input: readonly AllocationRecord[]): AllocationRecord[] {
  return input
    .filter((row) => row.invoiceCount > 0)
    .map((row) => ({ ...row, invoiceCount: Math.max(0, row.invoiceCount - 1) }))
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
  "dispatch": 0,
  "invoice": 0,
  "settlement": 0,
  "order": 0,
  "threshold": 0
};

export function withDefaults(partial: Partial<AllocationRecord>): AllocationRecord {
  return { id: '', state: 'audit', updatedAt: '', ...DEFAULTS, ...partial } as AllocationRecord;
}
