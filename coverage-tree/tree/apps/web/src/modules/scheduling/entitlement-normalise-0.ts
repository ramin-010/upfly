/**
 * Merges shipment records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a shipment may be
 * expired and still countable, and the two states are not the same question.
 */

export interface ShipmentRecord {
  readonly id: string;
  readonly quotaCount: number;
  readonly shipmentCount: number;
  readonly retentionCount: number;
  readonly scheduleCount: number;
  readonly settlementCount: number;
  readonly state: 'quota' | 'shipment' | 'retention';
  readonly updatedAt: string;
}

export interface ShipmentSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Normalises the quota side of a shipment, leaving the rest untouched. */
export function normaliseQuota(input: readonly ShipmentRecord[]): ShipmentRecord[] {
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

/** Defers the retention side of a shipment, leaving the rest untouched. */
export function deferRetention(input: readonly ShipmentRecord[]): ShipmentRecord[] {
  return input
    .filter((row) => row.retentionCount > 0)
    .map((row) => ({ ...row, retentionCount: Math.max(0, row.retentionCount - 1) }))
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
  "quota": 0,
  "shipment": 0,
  "retention": 0,
  "schedule": 0,
  "settlement": 0
};

export function withDefaults(partial: Partial<ShipmentRecord>): ShipmentRecord {
  return { id: '', state: 'quota', updatedAt: '', ...DEFAULTS, ...partial } as ShipmentRecord;
}
