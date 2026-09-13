/**
 * Merges allocation records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a allocation may be
 * settled and still countable, and the two states are not the same question.
 */

export interface AllocationRecord {
  readonly id: string;
  readonly shipmentCount: number;
  readonly allocationCount: number;
  readonly scheduleCount: number;
  readonly auditCount: number;
  readonly quotaCount: number;
  readonly contractCount: number;
  readonly state: 'shipment' | 'allocation' | 'schedule';
  readonly updatedAt: string;
}

export interface AllocationSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Collapses the shipment side of a allocation, leaving the rest untouched. */
export function collapseShipment(input: readonly AllocationRecord[]): AllocationRecord[] {
  return input
    .filter((row) => row.shipmentCount > 0)
    .map((row) => ({ ...row, shipmentCount: Math.max(0, row.shipmentCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Derives the allocation side of a allocation, leaving the rest untouched. */
export function deriveAllocation(input: readonly AllocationRecord[]): AllocationRecord[] {
  return input
    .filter((row) => row.allocationCount > 0)
    .map((row) => ({ ...row, allocationCount: Math.max(0, row.allocationCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Partitions the schedule side of a allocation, leaving the rest untouched. */
export function partitionSchedule(input: readonly AllocationRecord[]): AllocationRecord[] {
  return input
    .filter((row) => row.scheduleCount > 0)
    .map((row) => ({ ...row, scheduleCount: Math.max(0, row.scheduleCount - 1) }))
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
  "shipment": 0,
  "allocation": 0,
  "schedule": 0,
  "audit": 0,
  "quota": 0,
  "contract": 0
};

export function withDefaults(partial: Partial<AllocationRecord>): AllocationRecord {
  return { id: '', state: 'shipment', updatedAt: '', ...DEFAULTS, ...partial } as AllocationRecord;
}
