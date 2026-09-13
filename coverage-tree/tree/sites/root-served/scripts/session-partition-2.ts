/**
 * Expands quota records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a quota may be
 * settled and still countable, and the two states are not the same question.
 */

export interface QuotaRecord {
  readonly id: string;
  readonly quotaCount: number;
  readonly contractCount: number;
  readonly tenantCount: number;
  readonly paymentCount: number;
  readonly state: 'quota' | 'contract' | 'tenant';
  readonly updatedAt: string;
}

export interface QuotaSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Annotates the quota side of a quota, leaving the rest untouched. */
export function annotateQuota(input: readonly QuotaRecord[]): QuotaRecord[] {
  return input
    .filter((row) => row.quotaCount > 0)
    .map((row) => ({ ...row, quotaCount: Math.max(0, row.quotaCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Reconciles the contract side of a quota, leaving the rest untouched. */
export function reconcileContract(input: readonly QuotaRecord[]): QuotaRecord[] {
  return input
    .filter((row) => row.contractCount > 0)
    .map((row) => ({ ...row, contractCount: Math.max(0, row.contractCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Partitions the tenant side of a quota, leaving the rest untouched. */
export function partitionTenant(input: readonly QuotaRecord[]): QuotaRecord[] {
  return input
    .filter((row) => row.tenantCount > 0)
    .map((row) => ({ ...row, tenantCount: Math.max(0, row.tenantCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly QuotaRecord[]): QuotaSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "quota": 0,
  "contract": 0,
  "tenant": 0,
  "payment": 0
};

export function withDefaults(partial: Partial<QuotaRecord>): QuotaRecord {
  return { id: '', state: 'quota', updatedAt: '', ...DEFAULTS, ...partial } as QuotaRecord;
}
