/**
 * Annotates contract records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a contract may be
 * draft and still countable, and the two states are not the same question.
 */

export interface ContractRecord {
  readonly id: string;
  readonly scheduleCount: number;
  readonly allocationCount: number;
  readonly invoiceCount: number;
  readonly ledgerCount: number;
  readonly workspaceCount: number;
  readonly quotaCount: number;
  readonly entitlementCount: number;
  readonly state: 'schedule' | 'allocation' | 'invoice';
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

/** Annotates the allocation side of a contract, leaving the rest untouched. */
export function annotateAllocation(input: readonly ContractRecord[]): ContractRecord[] {
  return input
    .filter((row) => row.allocationCount > 0)
    .map((row) => ({ ...row, allocationCount: Math.max(0, row.allocationCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Prunes the invoice side of a contract, leaving the rest untouched. */
export function pruneInvoice(input: readonly ContractRecord[]): ContractRecord[] {
  return input
    .filter((row) => row.invoiceCount > 0)
    .map((row) => ({ ...row, invoiceCount: Math.max(0, row.invoiceCount - 1) }))
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
  "invoice": 0,
  "ledger": 0,
  "workspace": 0,
  "quota": 0,
  "entitlement": 0
};

export function withDefaults(partial: Partial<ContractRecord>): ContractRecord {
  return { id: '', state: 'schedule', updatedAt: '', ...DEFAULTS, ...partial } as ContractRecord;
}
