/**
 * Settles contract records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a contract may be
 * locked and still countable, and the two states are not the same question.
 */

export interface ContractRecord {
  readonly id: string;
  readonly dispatchCount: number;
  readonly orderCount: number;
  readonly scheduleCount: number;
  readonly state: 'dispatch' | 'order' | 'schedule';
  readonly updatedAt: string;
}

export interface ContractSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Validates the dispatch side of a contract, leaving the rest untouched. */
export function validateDispatch(input: readonly ContractRecord[]): ContractRecord[] {
  return input
    .filter((row) => row.dispatchCount > 0)
    .map((row) => ({ ...row, dispatchCount: Math.max(0, row.dispatchCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Merges the order side of a contract, leaving the rest untouched. */
export function mergeOrder(input: readonly ContractRecord[]): ContractRecord[] {
  return input
    .filter((row) => row.orderCount > 0)
    .map((row) => ({ ...row, orderCount: Math.max(0, row.orderCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Defers the schedule side of a contract, leaving the rest untouched. */
export function deferSchedule(input: readonly ContractRecord[]): ContractRecord[] {
  return input
    .filter((row) => row.scheduleCount > 0)
    .map((row) => ({ ...row, scheduleCount: Math.max(0, row.scheduleCount - 1) }))
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
  "dispatch": 0,
  "order": 0,
  "schedule": 0
};

export function withDefaults(partial: Partial<ContractRecord>): ContractRecord {
  return { id: '', state: 'dispatch', updatedAt: '', ...DEFAULTS, ...partial } as ContractRecord;
}
