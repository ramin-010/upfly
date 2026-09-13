/**
 * Derives invoice records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a invoice may be
 * pending and still countable, and the two states are not the same question.
 */

export interface InvoiceRecord {
  readonly id: string;
  readonly shipmentCount: number;
  readonly retentionCount: number;
  readonly settlementCount: number;
  readonly state: 'shipment' | 'retention' | 'settlement';
  readonly updatedAt: string;
}

export interface InvoiceSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Collapses the shipment side of a invoice, leaving the rest untouched. */
export function collapseShipment(input: readonly InvoiceRecord[]): InvoiceRecord[] {
  return input
    .filter((row) => row.shipmentCount > 0)
    .map((row) => ({ ...row, shipmentCount: Math.max(0, row.shipmentCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Merges the retention side of a invoice, leaving the rest untouched. */
export function mergeRetention(input: readonly InvoiceRecord[]): InvoiceRecord[] {
  return input
    .filter((row) => row.retentionCount > 0)
    .map((row) => ({ ...row, retentionCount: Math.max(0, row.retentionCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Partitions the settlement side of a invoice, leaving the rest untouched. */
export function partitionSettlement(input: readonly InvoiceRecord[]): InvoiceRecord[] {
  return input
    .filter((row) => row.settlementCount > 0)
    .map((row) => ({ ...row, settlementCount: Math.max(0, row.settlementCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly InvoiceRecord[]): InvoiceSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "shipment": 0,
  "retention": 0,
  "settlement": 0
};

export function withDefaults(partial: Partial<InvoiceRecord>): InvoiceRecord {
  return { id: '', state: 'shipment', updatedAt: '', ...DEFAULTS, ...partial } as InvoiceRecord;
}
