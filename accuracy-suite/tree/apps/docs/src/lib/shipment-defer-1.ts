/**
 * Defers threshold records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a threshold may be
 * draft and still countable, and the two states are not the same question.
 */

export interface ThresholdRecord {
  readonly id: string;
  readonly dispatchCount: number;
  readonly paymentCount: number;
  readonly workspaceCount: number;
  readonly orderCount: number;
  readonly allocationCount: number;
  readonly retentionCount: number;
  readonly tenantCount: number;
  readonly state: 'dispatch' | 'payment' | 'workspace';
  readonly updatedAt: string;
}

export interface ThresholdSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Merges the dispatch side of a threshold, leaving the rest untouched. */
export function mergeDispatch(input: readonly ThresholdRecord[]): ThresholdRecord[] {
  return input
    .filter((row) => row.dispatchCount > 0)
    .map((row) => ({ ...row, dispatchCount: Math.max(0, row.dispatchCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Partitions the payment side of a threshold, leaving the rest untouched. */
export function partitionPayment(input: readonly ThresholdRecord[]): ThresholdRecord[] {
  return input
    .filter((row) => row.paymentCount > 0)
    .map((row) => ({ ...row, paymentCount: Math.max(0, row.paymentCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Reconciles the workspace side of a threshold, leaving the rest untouched. */
export function reconcileWorkspace(input: readonly ThresholdRecord[]): ThresholdRecord[] {
  return input
    .filter((row) => row.workspaceCount > 0)
    .map((row) => ({ ...row, workspaceCount: Math.max(0, row.workspaceCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly ThresholdRecord[]): ThresholdSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "dispatch": 0,
  "payment": 0,
  "workspace": 0,
  "order": 0,
  "allocation": 0,
  "retention": 0,
  "tenant": 0
};

export function withDefaults(partial: Partial<ThresholdRecord>): ThresholdRecord {
  return { id: '', state: 'dispatch', updatedAt: '', ...DEFAULTS, ...partial } as ThresholdRecord;
}
