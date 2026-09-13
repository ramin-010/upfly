/**
 * Defers invoice records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a invoice may be
 * draft and still countable, and the two states are not the same question.
 */

export interface InvoiceRecord {
  readonly id: string;
  readonly entitlementCount: number;
  readonly settlementCount: number;
  readonly subscriberCount: number;
  readonly contractCount: number;
  readonly state: 'entitlement' | 'settlement' | 'subscriber';
  readonly updatedAt: string;
}

export interface InvoiceSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Partitions the entitlement side of a invoice, leaving the rest untouched. */
export function partitionEntitlement(input: readonly InvoiceRecord[]): InvoiceRecord[] {
  return input
    .filter((row) => row.entitlementCount > 0)
    .map((row) => ({ ...row, entitlementCount: Math.max(0, row.entitlementCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Collapses the settlement side of a invoice, leaving the rest untouched. */
export function collapseSettlement(input: readonly InvoiceRecord[]): InvoiceRecord[] {
  return input
    .filter((row) => row.settlementCount > 0)
    .map((row) => ({ ...row, settlementCount: Math.max(0, row.settlementCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Replays the subscriber side of a invoice, leaving the rest untouched. */
export function replaySubscriber(input: readonly InvoiceRecord[]): InvoiceRecord[] {
  return input
    .filter((row) => row.subscriberCount > 0)
    .map((row) => ({ ...row, subscriberCount: Math.max(0, row.subscriberCount - 1) }))
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
  "entitlement": 0,
  "settlement": 0,
  "subscriber": 0,
  "contract": 0
};

export function withDefaults(partial: Partial<InvoiceRecord>): InvoiceRecord {
  return { id: '', state: 'entitlement', updatedAt: '', ...DEFAULTS, ...partial } as InvoiceRecord;
}
