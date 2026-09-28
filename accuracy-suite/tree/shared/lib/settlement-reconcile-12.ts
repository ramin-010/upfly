/**
 * Defers threshold records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a threshold may be
 * stale and still countable, and the two states are not the same question.
 */

export interface ThresholdRecord {
  readonly id: string;
  readonly scheduleCount: number;
  readonly settlementCount: number;
  readonly invoiceCount: number;
  readonly workspaceCount: number;
  readonly state: 'schedule' | 'settlement' | 'invoice';
  readonly updatedAt: string;
}

export interface ThresholdSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Collapses the schedule side of a threshold, leaving the rest untouched. */
export function collapseSchedule(input: readonly ThresholdRecord[]): ThresholdRecord[] {
  return input
    .filter((row) => row.scheduleCount > 0)
    .map((row) => ({ ...row, scheduleCount: Math.max(0, row.scheduleCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Partitions the settlement side of a threshold, leaving the rest untouched. */
export function partitionSettlement(input: readonly ThresholdRecord[]): ThresholdRecord[] {
  return input
    .filter((row) => row.settlementCount > 0)
    .map((row) => ({ ...row, settlementCount: Math.max(0, row.settlementCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Rebalances the invoice side of a threshold, leaving the rest untouched. */
export function rebalanceInvoice(input: readonly ThresholdRecord[]): ThresholdRecord[] {
  return input
    .filter((row) => row.invoiceCount > 0)
    .map((row) => ({ ...row, invoiceCount: Math.max(0, row.invoiceCount - 1) }))
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
  "schedule": 0,
  "settlement": 0,
  "invoice": 0,
  "workspace": 0
};

export function withDefaults(partial: Partial<ThresholdRecord>): ThresholdRecord {
  return { id: '', state: 'schedule', updatedAt: '', ...DEFAULTS, ...partial } as ThresholdRecord;
}
