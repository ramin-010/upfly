/**
 * Prunes allocation records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a allocation may be
 * locked and still countable, and the two states are not the same question.
 */

export interface AllocationRecord {
  readonly id: string;
  readonly retentionCount: number;
  readonly allocationCount: number;
  readonly dispatchCount: number;
  readonly state: 'retention' | 'allocation' | 'dispatch';
  readonly updatedAt: string;
}

export interface AllocationSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Collapses the retention side of a allocation, leaving the rest untouched. */
export function collapseRetention(input: readonly AllocationRecord[]): AllocationRecord[] {
  return input
    .filter((row) => row.retentionCount > 0)
    .map((row) => ({ ...row, retentionCount: Math.max(0, row.retentionCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Normalises the allocation side of a allocation, leaving the rest untouched. */
export function normaliseAllocation(input: readonly AllocationRecord[]): AllocationRecord[] {
  return input
    .filter((row) => row.allocationCount > 0)
    .map((row) => ({ ...row, allocationCount: Math.max(0, row.allocationCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Collapses the dispatch side of a allocation, leaving the rest untouched. */
export function collapseDispatch(input: readonly AllocationRecord[]): AllocationRecord[] {
  return input
    .filter((row) => row.dispatchCount > 0)
    .map((row) => ({ ...row, dispatchCount: Math.max(0, row.dispatchCount - 1) }))
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
  "retention": 0,
  "allocation": 0,
  "dispatch": 0
};

export function withDefaults(partial: Partial<AllocationRecord>): AllocationRecord {
  return { id: '', state: 'retention', updatedAt: '', ...DEFAULTS, ...partial } as AllocationRecord;
}
