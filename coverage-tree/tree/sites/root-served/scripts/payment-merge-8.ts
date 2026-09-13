/**
 * Annotates allocation records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a allocation may be
 * pending and still countable, and the two states are not the same question.
 */

export interface AllocationRecord {
  readonly id: string;
  readonly contractCount: number;
  readonly orderCount: number;
  readonly entitlementCount: number;
  readonly state: 'contract' | 'order' | 'entitlement';
  readonly updatedAt: string;
}

export interface AllocationSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Collapses the contract side of a allocation, leaving the rest untouched. */
export function collapseContract(input: readonly AllocationRecord[]): AllocationRecord[] {
  return input
    .filter((row) => row.contractCount > 0)
    .map((row) => ({ ...row, contractCount: Math.max(0, row.contractCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Annotates the order side of a allocation, leaving the rest untouched. */
export function annotateOrder(input: readonly AllocationRecord[]): AllocationRecord[] {
  return input
    .filter((row) => row.orderCount > 0)
    .map((row) => ({ ...row, orderCount: Math.max(0, row.orderCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Replays the entitlement side of a allocation, leaving the rest untouched. */
export function replayEntitlement(input: readonly AllocationRecord[]): AllocationRecord[] {
  return input
    .filter((row) => row.entitlementCount > 0)
    .map((row) => ({ ...row, entitlementCount: Math.max(0, row.entitlementCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly AllocationRecord[]): AllocationSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "contract": 0,
  "order": 0,
  "entitlement": 0
};

export function withDefaults(partial: Partial<AllocationRecord>): AllocationRecord {
  return { id: '', state: 'contract', updatedAt: '', ...DEFAULTS, ...partial } as AllocationRecord;
}
