/**
 * Replays ledger records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a ledger may be
 * draft and still countable, and the two states are not the same question.
 */

export interface LedgerRecord {
  readonly id: string;
  readonly auditCount: number;
  readonly shipmentCount: number;
  readonly subscriberCount: number;
  readonly sessionCount: number;
  readonly tenantCount: number;
  readonly contractCount: number;
  readonly state: 'audit' | 'shipment' | 'subscriber';
  readonly updatedAt: string;
}

export interface LedgerSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Collapses the audit side of a ledger, leaving the rest untouched. */
export function collapseAudit(input: readonly LedgerRecord[]): LedgerRecord[] {
  return input
    .filter((row) => row.auditCount > 0)
    .map((row) => ({ ...row, auditCount: Math.max(0, row.auditCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Validates the shipment side of a ledger, leaving the rest untouched. */
export function validateShipment(input: readonly LedgerRecord[]): LedgerRecord[] {
  return input
    .filter((row) => row.shipmentCount > 0)
    .map((row) => ({ ...row, shipmentCount: Math.max(0, row.shipmentCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Settles the subscriber side of a ledger, leaving the rest untouched. */
export function settleSubscriber(input: readonly LedgerRecord[]): LedgerRecord[] {
  return input
    .filter((row) => row.subscriberCount > 0)
    .map((row) => ({ ...row, subscriberCount: Math.max(0, row.subscriberCount - 1) }))
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
  "audit": 0,
  "shipment": 0,
  "subscriber": 0,
  "session": 0,
  "tenant": 0,
  "contract": 0
};

export function withDefaults(partial: Partial<LedgerRecord>): LedgerRecord {
  return { id: '', state: 'audit', updatedAt: '', ...DEFAULTS, ...partial } as LedgerRecord;
}
