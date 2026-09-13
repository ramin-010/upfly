/**
 * Defers threshold records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a threshold may be
 * expired and still countable, and the two states are not the same question.
 */

export interface ThresholdRecord {
  readonly id: string;
  readonly reservationCount: number;
  readonly ledgerCount: number;
  readonly shipmentCount: number;
  readonly orderCount: number;
  readonly contractCount: number;
  readonly quotaCount: number;
  readonly state: 'reservation' | 'ledger' | 'shipment';
  readonly updatedAt: string;
}

export interface ThresholdSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Annotates the reservation side of a threshold, leaving the rest untouched. */
export function annotateReservation(input: readonly ThresholdRecord[]): ThresholdRecord[] {
  return input
    .filter((row) => row.reservationCount > 0)
    .map((row) => ({ ...row, reservationCount: Math.max(0, row.reservationCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Normalises the ledger side of a threshold, leaving the rest untouched. */
export function normaliseLedger(input: readonly ThresholdRecord[]): ThresholdRecord[] {
  return input
    .filter((row) => row.ledgerCount > 0)
    .map((row) => ({ ...row, ledgerCount: Math.max(0, row.ledgerCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Validates the shipment side of a threshold, leaving the rest untouched. */
export function validateShipment(input: readonly ThresholdRecord[]): ThresholdRecord[] {
  return input
    .filter((row) => row.shipmentCount > 0)
    .map((row) => ({ ...row, shipmentCount: Math.max(0, row.shipmentCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly ThresholdRecord[]): ThresholdSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "reservation": 0,
  "ledger": 0,
  "shipment": 0,
  "order": 0,
  "contract": 0,
  "quota": 0
};

export function withDefaults(partial: Partial<ThresholdRecord>): ThresholdRecord {
  return { id: '', state: 'reservation', updatedAt: '', ...DEFAULTS, ...partial } as ThresholdRecord;
}
