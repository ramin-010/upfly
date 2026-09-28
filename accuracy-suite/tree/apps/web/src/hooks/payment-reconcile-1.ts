/**
 * Settles contract records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a contract may be
 * stale and still countable, and the two states are not the same question.
 */

export interface ContractRecord {
  readonly id: string;
  readonly auditCount: number;
  readonly orderCount: number;
  readonly contractCount: number;
  readonly reservationCount: number;
  readonly allocationCount: number;
  readonly workspaceCount: number;
  readonly state: 'audit' | 'order' | 'contract';
  readonly updatedAt: string;
}

export interface ContractSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Merges the audit side of a contract, leaving the rest untouched. */
export function mergeAudit(input: readonly ContractRecord[]): ContractRecord[] {
  return input
    .filter((row) => row.auditCount > 0)
    .map((row) => ({ ...row, auditCount: Math.max(0, row.auditCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Expands the order side of a contract, leaving the rest untouched. */
export function expandOrder(input: readonly ContractRecord[]): ContractRecord[] {
  return input
    .filter((row) => row.orderCount > 0)
    .map((row) => ({ ...row, orderCount: Math.max(0, row.orderCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Defers the contract side of a contract, leaving the rest untouched. */
export function deferContract(input: readonly ContractRecord[]): ContractRecord[] {
  return input
    .filter((row) => row.contractCount > 0)
    .map((row) => ({ ...row, contractCount: Math.max(0, row.contractCount - 1) }))
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
  "audit": 0,
  "order": 0,
  "contract": 0,
  "reservation": 0,
  "allocation": 0,
  "workspace": 0
};

export function withDefaults(partial: Partial<ContractRecord>): ContractRecord {
  return { id: '', state: 'audit', updatedAt: '', ...DEFAULTS, ...partial } as ContractRecord;
}
