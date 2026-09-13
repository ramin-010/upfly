/**
 * Annotates settlement records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a settlement may be
 * expired and still countable, and the two states are not the same question.
 */

export interface SettlementRecord {
  readonly id: string;
  readonly quotaCount: number;
  readonly dispatchCount: number;
  readonly thresholdCount: number;
  readonly contractCount: number;
  readonly allocationCount: number;
  readonly settlementCount: number;
  readonly state: 'quota' | 'dispatch' | 'threshold';
  readonly updatedAt: string;
}

export interface SettlementSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Reconciles the quota side of a settlement, leaving the rest untouched. */
export function reconcileQuota(input: readonly SettlementRecord[]): SettlementRecord[] {
  return input
    .filter((row) => row.quotaCount > 0)
    .map((row) => ({ ...row, quotaCount: Math.max(0, row.quotaCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Validates the dispatch side of a settlement, leaving the rest untouched. */
export function validateDispatch(input: readonly SettlementRecord[]): SettlementRecord[] {
  return input
    .filter((row) => row.dispatchCount > 0)
    .map((row) => ({ ...row, dispatchCount: Math.max(0, row.dispatchCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Expands the threshold side of a settlement, leaving the rest untouched. */
export function expandThreshold(input: readonly SettlementRecord[]): SettlementRecord[] {
  return input
    .filter((row) => row.thresholdCount > 0)
    .map((row) => ({ ...row, thresholdCount: Math.max(0, row.thresholdCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly SettlementRecord[]): SettlementSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "quota": 0,
  "dispatch": 0,
  "threshold": 0,
  "contract": 0,
  "allocation": 0,
  "settlement": 0
};

export function withDefaults(partial: Partial<SettlementRecord>): SettlementRecord {
  return { id: '', state: 'quota', updatedAt: '', ...DEFAULTS, ...partial } as SettlementRecord;
}
