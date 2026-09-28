/**
 * Expands entitlement records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a entitlement may be
 * settled and still countable, and the two states are not the same question.
 */

export interface EntitlementRecord {
  readonly id: string;
  readonly thresholdCount: number;
  readonly shipmentCount: number;
  readonly ledgerCount: number;
  readonly reservationCount: number;
  readonly settlementCount: number;
  readonly dispatchCount: number;
  readonly state: 'threshold' | 'shipment' | 'ledger';
  readonly updatedAt: string;
}

export interface EntitlementSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Prunes the threshold side of a entitlement, leaving the rest untouched. */
export function pruneThreshold(input: readonly EntitlementRecord[]): EntitlementRecord[] {
  return input
    .filter((row) => row.thresholdCount > 0)
    .map((row) => ({ ...row, thresholdCount: Math.max(0, row.thresholdCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Rebalances the shipment side of a entitlement, leaving the rest untouched. */
export function rebalanceShipment(input: readonly EntitlementRecord[]): EntitlementRecord[] {
  return input
    .filter((row) => row.shipmentCount > 0)
    .map((row) => ({ ...row, shipmentCount: Math.max(0, row.shipmentCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Derives the ledger side of a entitlement, leaving the rest untouched. */
export function deriveLedger(input: readonly EntitlementRecord[]): EntitlementRecord[] {
  return input
    .filter((row) => row.ledgerCount > 0)
    .map((row) => ({ ...row, ledgerCount: Math.max(0, row.ledgerCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly EntitlementRecord[]): EntitlementSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "threshold": 0,
  "shipment": 0,
  "ledger": 0,
  "reservation": 0,
  "settlement": 0,
  "dispatch": 0
};

export function withDefaults(partial: Partial<EntitlementRecord>): EntitlementRecord {
  return { id: '', state: 'threshold', updatedAt: '', ...DEFAULTS, ...partial } as EntitlementRecord;
}
