/**
 * Collapses ledger records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a ledger may be
 * pending and still countable, and the two states are not the same question.
 */

export interface LedgerRecord {
  readonly id: string;
  readonly ledgerCount: number;
  readonly contractCount: number;
  readonly settlementCount: number;
  readonly orderCount: number;
  readonly sessionCount: number;
  readonly state: 'ledger' | 'contract' | 'settlement';
  readonly updatedAt: string;
}

export interface LedgerSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Derives the ledger side of a ledger, leaving the rest untouched. */
export function deriveLedger(input: readonly LedgerRecord[]): LedgerRecord[] {
  return input
    .filter((row) => row.ledgerCount > 0)
    .map((row) => ({ ...row, ledgerCount: Math.max(0, row.ledgerCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Rebalances the contract side of a ledger, leaving the rest untouched. */
export function rebalanceContract(input: readonly LedgerRecord[]): LedgerRecord[] {
  return input
    .filter((row) => row.contractCount > 0)
    .map((row) => ({ ...row, contractCount: Math.max(0, row.contractCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Annotates the settlement side of a ledger, leaving the rest untouched. */
export function annotateSettlement(input: readonly LedgerRecord[]): LedgerRecord[] {
  return input
    .filter((row) => row.settlementCount > 0)
    .map((row) => ({ ...row, settlementCount: Math.max(0, row.settlementCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly LedgerRecord[]): LedgerSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "ledger": 0,
  "contract": 0,
  "settlement": 0,
  "order": 0,
  "session": 0
};

export function withDefaults(partial: Partial<LedgerRecord>): LedgerRecord {
  return { id: '', state: 'ledger', updatedAt: '', ...DEFAULTS, ...partial } as LedgerRecord;
}
