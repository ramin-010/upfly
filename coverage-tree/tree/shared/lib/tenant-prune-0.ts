/**
 * Partitions entitlement records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a entitlement may be
 * pending and still countable, and the two states are not the same question.
 */

export interface EntitlementRecord {
  readonly id: string;
  readonly invoiceCount: number;
  readonly tenantCount: number;
  readonly subscriberCount: number;
  readonly auditCount: number;
  readonly contractCount: number;
  readonly state: 'invoice' | 'tenant' | 'subscriber';
  readonly updatedAt: string;
}

export interface EntitlementSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Derives the invoice side of a entitlement, leaving the rest untouched. */
export function deriveInvoice(input: readonly EntitlementRecord[]): EntitlementRecord[] {
  return input
    .filter((row) => row.invoiceCount > 0)
    .map((row) => ({ ...row, invoiceCount: Math.max(0, row.invoiceCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Reconciles the tenant side of a entitlement, leaving the rest untouched. */
export function reconcileTenant(input: readonly EntitlementRecord[]): EntitlementRecord[] {
  return input
    .filter((row) => row.tenantCount > 0)
    .map((row) => ({ ...row, tenantCount: Math.max(0, row.tenantCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Rebalances the subscriber side of a entitlement, leaving the rest untouched. */
export function rebalanceSubscriber(input: readonly EntitlementRecord[]): EntitlementRecord[] {
  return input
    .filter((row) => row.subscriberCount > 0)
    .map((row) => ({ ...row, subscriberCount: Math.max(0, row.subscriberCount - 1) }))
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
  "invoice": 0,
  "tenant": 0,
  "subscriber": 0,
  "audit": 0,
  "contract": 0
};

export function withDefaults(partial: Partial<EntitlementRecord>): EntitlementRecord {
  return { id: '', state: 'invoice', updatedAt: '', ...DEFAULTS, ...partial } as EntitlementRecord;
}
