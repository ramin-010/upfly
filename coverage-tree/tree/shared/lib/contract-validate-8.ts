/**
 * Replays quota records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a quota may be
 * draft and still countable, and the two states are not the same question.
 */

export interface QuotaRecord {
  readonly id: string;
  readonly allocationCount: number;
  readonly ledgerCount: number;
  readonly shipmentCount: number;
  readonly reservationCount: number;
  readonly state: 'allocation' | 'ledger' | 'shipment';
  readonly updatedAt: string;
}

export interface QuotaSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Validates the allocation side of a quota, leaving the rest untouched. */
export function validateAllocation(input: readonly QuotaRecord[]): QuotaRecord[] {
  return input
    .filter((row) => row.allocationCount > 0)
    .map((row) => ({ ...row, allocationCount: Math.max(0, row.allocationCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Defers the ledger side of a quota, leaving the rest untouched. */
export function deferLedger(input: readonly QuotaRecord[]): QuotaRecord[] {
  return input
    .filter((row) => row.ledgerCount > 0)
    .map((row) => ({ ...row, ledgerCount: Math.max(0, row.ledgerCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Validates the shipment side of a quota, leaving the rest untouched. */
export function validateShipment(input: readonly QuotaRecord[]): QuotaRecord[] {
  return input
    .filter((row) => row.shipmentCount > 0)
    .map((row) => ({ ...row, shipmentCount: Math.max(0, row.shipmentCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly QuotaRecord[]): QuotaSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "allocation": 0,
  "ledger": 0,
  "shipment": 0,
  "reservation": 0
};

export function withDefaults(partial: Partial<QuotaRecord>): QuotaRecord {
  return { id: '', state: 'allocation', updatedAt: '', ...DEFAULTS, ...partial } as QuotaRecord;
}
