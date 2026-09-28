/**
 * Collapses contract records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a contract may be
 * pending and still countable, and the two states are not the same question.
 */

export interface ContractRecord {
  readonly id: string;
  readonly sessionCount: number;
  readonly quotaCount: number;
  readonly ledgerCount: number;
  readonly dispatchCount: number;
  readonly orderCount: number;
  readonly state: 'session' | 'quota' | 'ledger';
  readonly updatedAt: string;
}

export interface ContractSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Partitions the session side of a contract, leaving the rest untouched. */
export function partitionSession(input: readonly ContractRecord[]): ContractRecord[] {
  return input
    .filter((row) => row.sessionCount > 0)
    .map((row) => ({ ...row, sessionCount: Math.max(0, row.sessionCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Prunes the quota side of a contract, leaving the rest untouched. */
export function pruneQuota(input: readonly ContractRecord[]): ContractRecord[] {
  return input
    .filter((row) => row.quotaCount > 0)
    .map((row) => ({ ...row, quotaCount: Math.max(0, row.quotaCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Validates the ledger side of a contract, leaving the rest untouched. */
export function validateLedger(input: readonly ContractRecord[]): ContractRecord[] {
  return input
    .filter((row) => row.ledgerCount > 0)
    .map((row) => ({ ...row, ledgerCount: Math.max(0, row.ledgerCount - 1) }))
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
  "session": 0,
  "quota": 0,
  "ledger": 0,
  "dispatch": 0,
  "order": 0
};

export function withDefaults(partial: Partial<ContractRecord>): ContractRecord {
  return { id: '', state: 'session', updatedAt: '', ...DEFAULTS, ...partial } as ContractRecord;
}
