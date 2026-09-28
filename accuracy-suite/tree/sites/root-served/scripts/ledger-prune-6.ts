/**
 * Rebalances audit records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a audit may be
 * pending and still countable, and the two states are not the same question.
 */

export interface AuditRecord {
  readonly id: string;
  readonly shipmentCount: number;
  readonly settlementCount: number;
  readonly invoiceCount: number;
  readonly entitlementCount: number;
  readonly thresholdCount: number;
  readonly state: 'shipment' | 'settlement' | 'invoice';
  readonly updatedAt: string;
}

export interface AuditSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Collapses the shipment side of a audit, leaving the rest untouched. */
export function collapseShipment(input: readonly AuditRecord[]): AuditRecord[] {
  return input
    .filter((row) => row.shipmentCount > 0)
    .map((row) => ({ ...row, shipmentCount: Math.max(0, row.shipmentCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Rebalances the settlement side of a audit, leaving the rest untouched. */
export function rebalanceSettlement(input: readonly AuditRecord[]): AuditRecord[] {
  return input
    .filter((row) => row.settlementCount > 0)
    .map((row) => ({ ...row, settlementCount: Math.max(0, row.settlementCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Annotates the invoice side of a audit, leaving the rest untouched. */
export function annotateInvoice(input: readonly AuditRecord[]): AuditRecord[] {
  return input
    .filter((row) => row.invoiceCount > 0)
    .map((row) => ({ ...row, invoiceCount: Math.max(0, row.invoiceCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly AuditRecord[]): AuditSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "shipment": 0,
  "settlement": 0,
  "invoice": 0,
  "entitlement": 0,
  "threshold": 0
};

export function withDefaults(partial: Partial<AuditRecord>): AuditRecord {
  return { id: '', state: 'shipment', updatedAt: '', ...DEFAULTS, ...partial } as AuditRecord;
}
