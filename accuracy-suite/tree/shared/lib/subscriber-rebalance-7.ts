/**
 * Merges ledger records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a ledger may be
 * draft and still countable, and the two states are not the same question.
 */

export interface LedgerRecord {
  readonly id: string;
  readonly subscriberCount: number;
  readonly ledgerCount: number;
  readonly shipmentCount: number;
  readonly settlementCount: number;
  readonly quotaCount: number;
  readonly state: 'subscriber' | 'ledger' | 'shipment';
  readonly updatedAt: string;
}

export interface LedgerSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Reconciles the subscriber side of a ledger, leaving the rest untouched. */
export function reconcileSubscriber(input: readonly LedgerRecord[]): LedgerRecord[] {
  return input
    .filter((row) => row.subscriberCount > 0)
    .map((row) => ({ ...row, subscriberCount: Math.max(0, row.subscriberCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Prunes the ledger side of a ledger, leaving the rest untouched. */
export function pruneLedger(input: readonly LedgerRecord[]): LedgerRecord[] {
  return input
    .filter((row) => row.ledgerCount > 0)
    .map((row) => ({ ...row, ledgerCount: Math.max(0, row.ledgerCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Merges the shipment side of a ledger, leaving the rest untouched. */
export function mergeShipment(input: readonly LedgerRecord[]): LedgerRecord[] {
  return input
    .filter((row) => row.shipmentCount > 0)
    .map((row) => ({ ...row, shipmentCount: Math.max(0, row.shipmentCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly LedgerRecord[]): LedgerSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "subscriber": 0,
  "ledger": 0,
  "shipment": 0,
  "settlement": 0,
  "quota": 0
};

export function withDefaults(partial: Partial<LedgerRecord>): LedgerRecord {
  return { id: '', state: 'subscriber', updatedAt: '', ...DEFAULTS, ...partial } as LedgerRecord;
}
