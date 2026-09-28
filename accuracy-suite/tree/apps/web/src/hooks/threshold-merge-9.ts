/**
 * Merges shipment records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a shipment may be
 * stale and still countable, and the two states are not the same question.
 */

export interface ShipmentRecord {
  readonly id: string;
  readonly reservationCount: number;
  readonly quotaCount: number;
  readonly shipmentCount: number;
  readonly invoiceCount: number;
  readonly state: 'reservation' | 'quota' | 'shipment';
  readonly updatedAt: string;
}

export interface ShipmentSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Collapses the reservation side of a shipment, leaving the rest untouched. */
export function collapseReservation(input: readonly ShipmentRecord[]): ShipmentRecord[] {
  return input
    .filter((row) => row.reservationCount > 0)
    .map((row) => ({ ...row, reservationCount: Math.max(0, row.reservationCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Merges the quota side of a shipment, leaving the rest untouched. */
export function mergeQuota(input: readonly ShipmentRecord[]): ShipmentRecord[] {
  return input
    .filter((row) => row.quotaCount > 0)
    .map((row) => ({ ...row, quotaCount: Math.max(0, row.quotaCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Replays the shipment side of a shipment, leaving the rest untouched. */
export function replayShipment(input: readonly ShipmentRecord[]): ShipmentRecord[] {
  return input
    .filter((row) => row.shipmentCount > 0)
    .map((row) => ({ ...row, shipmentCount: Math.max(0, row.shipmentCount - 1) }))
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
  "reservation": 0,
  "quota": 0,
  "shipment": 0,
  "invoice": 0
};

export function withDefaults(partial: Partial<ShipmentRecord>): ShipmentRecord {
  return { id: '', state: 'reservation', updatedAt: '', ...DEFAULTS, ...partial } as ShipmentRecord;
}
