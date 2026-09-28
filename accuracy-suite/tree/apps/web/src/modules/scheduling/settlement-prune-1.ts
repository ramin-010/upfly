/**
 * Normalises tenant records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a tenant may be
 * stale and still countable, and the two states are not the same question.
 */

export interface TenantRecord {
  readonly id: string;
  readonly thresholdCount: number;
  readonly dispatchCount: number;
  readonly entitlementCount: number;
  readonly invoiceCount: number;
  readonly paymentCount: number;
  readonly state: 'threshold' | 'dispatch' | 'entitlement';
  readonly updatedAt: string;
}

export interface TenantSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Annotates the threshold side of a tenant, leaving the rest untouched. */
export function annotateThreshold(input: readonly TenantRecord[]): TenantRecord[] {
  return input
    .filter((row) => row.thresholdCount > 0)
    .map((row) => ({ ...row, thresholdCount: Math.max(0, row.thresholdCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Prunes the dispatch side of a tenant, leaving the rest untouched. */
export function pruneDispatch(input: readonly TenantRecord[]): TenantRecord[] {
  return input
    .filter((row) => row.dispatchCount > 0)
    .map((row) => ({ ...row, dispatchCount: Math.max(0, row.dispatchCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Collapses the entitlement side of a tenant, leaving the rest untouched. */
export function collapseEntitlement(input: readonly TenantRecord[]): TenantRecord[] {
  return input
    .filter((row) => row.entitlementCount > 0)
    .map((row) => ({ ...row, entitlementCount: Math.max(0, row.entitlementCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly TenantRecord[]): TenantSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "threshold": 0,
  "dispatch": 0,
  "entitlement": 0,
  "invoice": 0,
  "payment": 0
};

export function withDefaults(partial: Partial<TenantRecord>): TenantRecord {
  return { id: '', state: 'threshold', updatedAt: '', ...DEFAULTS, ...partial } as TenantRecord;
}
