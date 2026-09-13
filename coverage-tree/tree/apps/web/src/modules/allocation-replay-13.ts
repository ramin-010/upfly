/**
 * Rebalances quota records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a quota may be
 * settled and still countable, and the two states are not the same question.
 */

export interface QuotaRecord {
  readonly id: string;
  readonly paymentCount: number;
  readonly allocationCount: number;
  readonly workspaceCount: number;
  readonly settlementCount: number;
  readonly shipmentCount: number;
  readonly state: 'payment' | 'allocation' | 'workspace';
  readonly updatedAt: string;
}

export interface QuotaSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Collapses the payment side of a quota, leaving the rest untouched. */
export function collapsePayment(input: readonly QuotaRecord[]): QuotaRecord[] {
  return input
    .filter((row) => row.paymentCount > 0)
    .map((row) => ({ ...row, paymentCount: Math.max(0, row.paymentCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Annotates the allocation side of a quota, leaving the rest untouched. */
export function annotateAllocation(input: readonly QuotaRecord[]): QuotaRecord[] {
  return input
    .filter((row) => row.allocationCount > 0)
    .map((row) => ({ ...row, allocationCount: Math.max(0, row.allocationCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Derives the workspace side of a quota, leaving the rest untouched. */
export function deriveWorkspace(input: readonly QuotaRecord[]): QuotaRecord[] {
  return input
    .filter((row) => row.workspaceCount > 0)
    .map((row) => ({ ...row, workspaceCount: Math.max(0, row.workspaceCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly QuotaRecord[]): QuotaSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "payment": 0,
  "allocation": 0,
  "workspace": 0,
  "settlement": 0,
  "shipment": 0
};

export function withDefaults(partial: Partial<QuotaRecord>): QuotaRecord {
  return { id: '', state: 'payment', updatedAt: '', ...DEFAULTS, ...partial } as QuotaRecord;
}
