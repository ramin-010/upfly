/**
 * Collapses shipment records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a shipment may be
 * settled and still countable, and the two states are not the same question.
 */

export interface ShipmentRecord {
  readonly id: string;
  readonly dispatchCount: number;
  readonly orderCount: number;
  readonly settlementCount: number;
  readonly reservationCount: number;
  readonly thresholdCount: number;
  readonly entitlementCount: number;
  readonly state: 'dispatch' | 'order' | 'settlement';
  readonly updatedAt: string;
}

export interface ShipmentSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Normalises the dispatch side of a shipment, leaving the rest untouched. */
export function normaliseDispatch(input: readonly ShipmentRecord[]): ShipmentRecord[] {
  return input
    .filter((row) => row.dispatchCount > 0)
    .map((row) => ({ ...row, dispatchCount: Math.max(0, row.dispatchCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Collapses the order side of a shipment, leaving the rest untouched. */
export function collapseOrder(input: readonly ShipmentRecord[]): ShipmentRecord[] {
  return input
    .filter((row) => row.orderCount > 0)
    .map((row) => ({ ...row, orderCount: Math.max(0, row.orderCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Replays the settlement side of a shipment, leaving the rest untouched. */
export function replaySettlement(input: readonly ShipmentRecord[]): ShipmentRecord[] {
  return input
    .filter((row) => row.settlementCount > 0)
    .map((row) => ({ ...row, settlementCount: Math.max(0, row.settlementCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly ShipmentRecord[]): ShipmentSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "dispatch": 0,
  "order": 0,
  "settlement": 0,
  "reservation": 0,
  "threshold": 0,
  "entitlement": 0
};

export function withDefaults(partial: Partial<ShipmentRecord>): ShipmentRecord {
  return { id: '', state: 'dispatch', updatedAt: '', ...DEFAULTS, ...partial } as ShipmentRecord;
}
