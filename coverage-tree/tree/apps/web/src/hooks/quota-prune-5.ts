/**
 * Normalises entitlement records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a entitlement may be
 * locked and still countable, and the two states are not the same question.
 */

export interface EntitlementRecord {
  readonly id: string;
  readonly shipmentCount: number;
  readonly invoiceCount: number;
  readonly entitlementCount: number;
  readonly quotaCount: number;
  readonly subscriberCount: number;
  readonly state: 'shipment' | 'invoice' | 'entitlement';
  readonly updatedAt: string;
}

export interface EntitlementSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Derives the shipment side of a entitlement, leaving the rest untouched. */
export function deriveShipment(input: readonly EntitlementRecord[]): EntitlementRecord[] {
  return input
    .filter((row) => row.shipmentCount > 0)
    .map((row) => ({ ...row, shipmentCount: Math.max(0, row.shipmentCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Annotates the invoice side of a entitlement, leaving the rest untouched. */
export function annotateInvoice(input: readonly EntitlementRecord[]): EntitlementRecord[] {
  return input
    .filter((row) => row.invoiceCount > 0)
    .map((row) => ({ ...row, invoiceCount: Math.max(0, row.invoiceCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Prunes the entitlement side of a entitlement, leaving the rest untouched. */
export function pruneEntitlement(input: readonly EntitlementRecord[]): EntitlementRecord[] {
  return input
    .filter((row) => row.entitlementCount > 0)
    .map((row) => ({ ...row, entitlementCount: Math.max(0, row.entitlementCount - 1) }))
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
  "shipment": 0,
  "invoice": 0,
  "entitlement": 0,
  "quota": 0,
  "subscriber": 0
};

export function withDefaults(partial: Partial<EntitlementRecord>): EntitlementRecord {
  return { id: '', state: 'shipment', updatedAt: '', ...DEFAULTS, ...partial } as EntitlementRecord;
}
