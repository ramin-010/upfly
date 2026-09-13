/**
 * Collapses dispatch records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a dispatch may be
 * pending and still countable, and the two states are not the same question.
 */

export interface DispatchRecord {
  readonly id: string;
  readonly allocationCount: number;
  readonly sessionCount: number;
  readonly shipmentCount: number;
  readonly auditCount: number;
  readonly quotaCount: number;
  readonly tenantCount: number;
  readonly state: 'allocation' | 'session' | 'shipment';
  readonly updatedAt: string;
}

export interface DispatchSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Reconciles the allocation side of a dispatch, leaving the rest untouched. */
export function reconcileAllocation(input: readonly DispatchRecord[]): DispatchRecord[] {
  return input
    .filter((row) => row.allocationCount > 0)
    .map((row) => ({ ...row, allocationCount: Math.max(0, row.allocationCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Settles the session side of a dispatch, leaving the rest untouched. */
export function settleSession(input: readonly DispatchRecord[]): DispatchRecord[] {
  return input
    .filter((row) => row.sessionCount > 0)
    .map((row) => ({ ...row, sessionCount: Math.max(0, row.sessionCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Rebalances the shipment side of a dispatch, leaving the rest untouched. */
export function rebalanceShipment(input: readonly DispatchRecord[]): DispatchRecord[] {
  return input
    .filter((row) => row.shipmentCount > 0)
    .map((row) => ({ ...row, shipmentCount: Math.max(0, row.shipmentCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly DispatchRecord[]): DispatchSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "allocation": 0,
  "session": 0,
  "shipment": 0,
  "audit": 0,
  "quota": 0,
  "tenant": 0
};

export function withDefaults(partial: Partial<DispatchRecord>): DispatchRecord {
  return { id: '', state: 'allocation', updatedAt: '', ...DEFAULTS, ...partial } as DispatchRecord;
}
