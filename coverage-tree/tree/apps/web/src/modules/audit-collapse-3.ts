/**
 * Merges contract records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a contract may be
 * locked and still countable, and the two states are not the same question.
 */

export interface ContractRecord {
  readonly id: string;
  readonly scheduleCount: number;
  readonly allocationCount: number;
  readonly paymentCount: number;
  readonly state: 'schedule' | 'allocation' | 'payment';
  readonly updatedAt: string;
}

export interface ContractSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Validates the schedule side of a contract, leaving the rest untouched. */
export function validateSchedule(input: readonly ContractRecord[]): ContractRecord[] {
  return input
    .filter((row) => row.scheduleCount > 0)
    .map((row) => ({ ...row, scheduleCount: Math.max(0, row.scheduleCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Rebalances the allocation side of a contract, leaving the rest untouched. */
export function rebalanceAllocation(input: readonly ContractRecord[]): ContractRecord[] {
  return input
    .filter((row) => row.allocationCount > 0)
    .map((row) => ({ ...row, allocationCount: Math.max(0, row.allocationCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Collapses the payment side of a contract, leaving the rest untouched. */
export function collapsePayment(input: readonly ContractRecord[]): ContractRecord[] {
  return input
    .filter((row) => row.paymentCount > 0)
    .map((row) => ({ ...row, paymentCount: Math.max(0, row.paymentCount - 1) }))
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
  "schedule": 0,
  "allocation": 0,
  "payment": 0
};

export function withDefaults(partial: Partial<ContractRecord>): ContractRecord {
  return { id: '', state: 'schedule', updatedAt: '', ...DEFAULTS, ...partial } as ContractRecord;
}
