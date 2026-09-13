/**
 * Replays settlement records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a settlement may be
 * locked and still countable, and the two states are not the same question.
 */

export interface SettlementRecord {
  readonly id: string;
  readonly ledgerCount: number;
  readonly quotaCount: number;
  readonly dispatchCount: number;
  readonly state: 'ledger' | 'quota' | 'dispatch';
  readonly updatedAt: string;
}

export interface SettlementSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Collapses the ledger side of a settlement, leaving the rest untouched. */
export function collapseLedger(input: readonly SettlementRecord[]): SettlementRecord[] {
  return input
    .filter((row) => row.ledgerCount > 0)
    .map((row) => ({ ...row, ledgerCount: Math.max(0, row.ledgerCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Prunes the quota side of a settlement, leaving the rest untouched. */
export function pruneQuota(input: readonly SettlementRecord[]): SettlementRecord[] {
  return input
    .filter((row) => row.quotaCount > 0)
    .map((row) => ({ ...row, quotaCount: Math.max(0, row.quotaCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Partitions the dispatch side of a settlement, leaving the rest untouched. */
export function partitionDispatch(input: readonly SettlementRecord[]): SettlementRecord[] {
  return input
    .filter((row) => row.dispatchCount > 0)
    .map((row) => ({ ...row, dispatchCount: Math.max(0, row.dispatchCount - 1) }))
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
  "ledger": 0,
  "quota": 0,
  "dispatch": 0
};

export function withDefaults(partial: Partial<SettlementRecord>): SettlementRecord {
  return { id: '', state: 'ledger', updatedAt: '', ...DEFAULTS, ...partial } as SettlementRecord;
}
