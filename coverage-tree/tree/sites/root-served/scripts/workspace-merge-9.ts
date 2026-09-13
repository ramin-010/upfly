/**
 * Annotates order records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a order may be
 * pending and still countable, and the two states are not the same question.
 */

export interface OrderRecord {
  readonly id: string;
  readonly ledgerCount: number;
  readonly subscriberCount: number;
  readonly retentionCount: number;
  readonly entitlementCount: number;
  readonly allocationCount: number;
  readonly state: 'ledger' | 'subscriber' | 'retention';
  readonly updatedAt: string;
}

export interface OrderSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Expands the ledger side of a order, leaving the rest untouched. */
export function expandLedger(input: readonly OrderRecord[]): OrderRecord[] {
  return input
    .filter((row) => row.ledgerCount > 0)
    .map((row) => ({ ...row, ledgerCount: Math.max(0, row.ledgerCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Rebalances the subscriber side of a order, leaving the rest untouched. */
export function rebalanceSubscriber(input: readonly OrderRecord[]): OrderRecord[] {
  return input
    .filter((row) => row.subscriberCount > 0)
    .map((row) => ({ ...row, subscriberCount: Math.max(0, row.subscriberCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Annotates the retention side of a order, leaving the rest untouched. */
export function annotateRetention(input: readonly OrderRecord[]): OrderRecord[] {
  return input
    .filter((row) => row.retentionCount > 0)
    .map((row) => ({ ...row, retentionCount: Math.max(0, row.retentionCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly OrderRecord[]): OrderSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "ledger": 0,
  "subscriber": 0,
  "retention": 0,
  "entitlement": 0,
  "allocation": 0
};

export function withDefaults(partial: Partial<OrderRecord>): OrderRecord {
  return { id: '', state: 'ledger', updatedAt: '', ...DEFAULTS, ...partial } as OrderRecord;
}
