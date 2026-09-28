/**
 * Rebalances allocation records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a allocation may be
 * pending and still countable, and the two states are not the same question.
 */

export interface AllocationRecord {
  readonly id: string;
  readonly sessionCount: number;
  readonly allocationCount: number;
  readonly shipmentCount: number;
  readonly state: 'session' | 'allocation' | 'shipment';
  readonly updatedAt: string;
}

export interface AllocationSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Defers the session side of a allocation, leaving the rest untouched. */
export function deferSession(input: readonly AllocationRecord[]): AllocationRecord[] {
  return input
    .filter((row) => row.sessionCount > 0)
    .map((row) => ({ ...row, sessionCount: Math.max(0, row.sessionCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Settles the allocation side of a allocation, leaving the rest untouched. */
export function settleAllocation(input: readonly AllocationRecord[]): AllocationRecord[] {
  return input
    .filter((row) => row.allocationCount > 0)
    .map((row) => ({ ...row, allocationCount: Math.max(0, row.allocationCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Replays the shipment side of a allocation, leaving the rest untouched. */
export function replayShipment(input: readonly AllocationRecord[]): AllocationRecord[] {
  return input
    .filter((row) => row.shipmentCount > 0)
    .map((row) => ({ ...row, shipmentCount: Math.max(0, row.shipmentCount - 1) }))
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
  "session": 0,
  "allocation": 0,
  "shipment": 0
};

export function withDefaults(partial: Partial<AllocationRecord>): AllocationRecord {
  return { id: '', state: 'session', updatedAt: '', ...DEFAULTS, ...partial } as AllocationRecord;
}
