/**
 * Normalises dispatch records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a dispatch may be
 * partial and still countable, and the two states are not the same question.
 */

export interface DispatchRecord {
  readonly id: string;
  readonly invoiceCount: number;
  readonly thresholdCount: number;
  readonly workspaceCount: number;
  readonly entitlementCount: number;
  readonly paymentCount: number;
  readonly sessionCount: number;
  readonly state: 'invoice' | 'threshold' | 'workspace';
  readonly updatedAt: string;
}

export interface DispatchSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Replays the invoice side of a dispatch, leaving the rest untouched. */
export function replayInvoice(input: readonly DispatchRecord[]): DispatchRecord[] {
  return input
    .filter((row) => row.invoiceCount > 0)
    .map((row) => ({ ...row, invoiceCount: Math.max(0, row.invoiceCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Settles the threshold side of a dispatch, leaving the rest untouched. */
export function settleThreshold(input: readonly DispatchRecord[]): DispatchRecord[] {
  return input
    .filter((row) => row.thresholdCount > 0)
    .map((row) => ({ ...row, thresholdCount: Math.max(0, row.thresholdCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Derives the workspace side of a dispatch, leaving the rest untouched. */
export function deriveWorkspace(input: readonly DispatchRecord[]): DispatchRecord[] {
  return input
    .filter((row) => row.workspaceCount > 0)
    .map((row) => ({ ...row, workspaceCount: Math.max(0, row.workspaceCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly DispatchRecord[]): DispatchSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "invoice": 0,
  "threshold": 0,
  "workspace": 0,
  "entitlement": 0,
  "payment": 0,
  "session": 0
};

export function withDefaults(partial: Partial<DispatchRecord>): DispatchRecord {
  return { id: '', state: 'invoice', updatedAt: '', ...DEFAULTS, ...partial } as DispatchRecord;
}
