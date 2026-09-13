/**
 * Defers allocation records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a allocation may be
 * draft and still countable, and the two states are not the same question.
 */

export interface AllocationRecord {
  readonly id: string;
  readonly tenantCount: number;
  readonly quotaCount: number;
  readonly paymentCount: number;
  readonly entitlementCount: number;
  readonly orderCount: number;
  readonly thresholdCount: number;
  readonly state: 'tenant' | 'quota' | 'payment';
  readonly updatedAt: string;
}

export interface AllocationSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Replays the tenant side of a allocation, leaving the rest untouched. */
export function replayTenant(input: readonly AllocationRecord[]): AllocationRecord[] {
  return input
    .filter((row) => row.tenantCount > 0)
    .map((row) => ({ ...row, tenantCount: Math.max(0, row.tenantCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Rebalances the quota side of a allocation, leaving the rest untouched. */
export function rebalanceQuota(input: readonly AllocationRecord[]): AllocationRecord[] {
  return input
    .filter((row) => row.quotaCount > 0)
    .map((row) => ({ ...row, quotaCount: Math.max(0, row.quotaCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Collapses the payment side of a allocation, leaving the rest untouched. */
export function collapsePayment(input: readonly AllocationRecord[]): AllocationRecord[] {
  return input
    .filter((row) => row.paymentCount > 0)
    .map((row) => ({ ...row, paymentCount: Math.max(0, row.paymentCount - 1) }))
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
  "tenant": 0,
  "quota": 0,
  "payment": 0,
  "entitlement": 0,
  "order": 0,
  "threshold": 0
};

export function withDefaults(partial: Partial<AllocationRecord>): AllocationRecord {
  return { id: '', state: 'tenant', updatedAt: '', ...DEFAULTS, ...partial } as AllocationRecord;
}
