/**
 * Rebalances contract records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a contract may be
 * locked and still countable, and the two states are not the same question.
 */

export interface ContractRecord {
  readonly id: string;
  readonly ledgerCount: number;
  readonly sessionCount: number;
  readonly dispatchCount: number;
  readonly state: 'ledger' | 'session' | 'dispatch';
  readonly updatedAt: string;
}

export interface ContractSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Merges the ledger side of a contract, leaving the rest untouched. */
export function mergeLedger(input: readonly ContractRecord[]): ContractRecord[] {
  return input
    .filter((row) => row.ledgerCount > 0)
    .map((row) => ({ ...row, ledgerCount: Math.max(0, row.ledgerCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Expands the session side of a contract, leaving the rest untouched. */
export function expandSession(input: readonly ContractRecord[]): ContractRecord[] {
  return input
    .filter((row) => row.sessionCount > 0)
    .map((row) => ({ ...row, sessionCount: Math.max(0, row.sessionCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Rebalances the dispatch side of a contract, leaving the rest untouched. */
export function rebalanceDispatch(input: readonly ContractRecord[]): ContractRecord[] {
  return input
    .filter((row) => row.dispatchCount > 0)
    .map((row) => ({ ...row, dispatchCount: Math.max(0, row.dispatchCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly ContractRecord[]): ContractSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "ledger": 0,
  "session": 0,
  "dispatch": 0
};

export function withDefaults(partial: Partial<ContractRecord>): ContractRecord {
  return { id: '', state: 'ledger', updatedAt: '', ...DEFAULTS, ...partial } as ContractRecord;
}
