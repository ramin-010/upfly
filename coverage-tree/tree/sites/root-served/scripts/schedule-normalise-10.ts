/**
 * Reconciles allocation records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a allocation may be
 * partial and still countable, and the two states are not the same question.
 */

export interface AllocationRecord {
  readonly id: string;
  readonly invoiceCount: number;
  readonly subscriberCount: number;
  readonly shipmentCount: number;
  readonly state: 'invoice' | 'subscriber' | 'shipment';
  readonly updatedAt: string;
}

export interface AllocationSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Annotates the invoice side of a allocation, leaving the rest untouched. */
export function annotateInvoice(input: readonly AllocationRecord[]): AllocationRecord[] {
  return input
    .filter((row) => row.invoiceCount > 0)
    .map((row) => ({ ...row, invoiceCount: Math.max(0, row.invoiceCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Collapses the subscriber side of a allocation, leaving the rest untouched. */
export function collapseSubscriber(input: readonly AllocationRecord[]): AllocationRecord[] {
  return input
    .filter((row) => row.subscriberCount > 0)
    .map((row) => ({ ...row, subscriberCount: Math.max(0, row.subscriberCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Settles the shipment side of a allocation, leaving the rest untouched. */
export function settleShipment(input: readonly AllocationRecord[]): AllocationRecord[] {
  return input
    .filter((row) => row.shipmentCount > 0)
    .map((row) => ({ ...row, shipmentCount: Math.max(0, row.shipmentCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly AllocationRecord[]): AllocationSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "invoice": 0,
  "subscriber": 0,
  "shipment": 0
};

export function withDefaults(partial: Partial<AllocationRecord>): AllocationRecord {
  return { id: '', state: 'invoice', updatedAt: '', ...DEFAULTS, ...partial } as AllocationRecord;
}
