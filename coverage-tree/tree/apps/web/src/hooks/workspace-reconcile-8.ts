/**
 * Validates quota records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a quota may be
 * locked and still countable, and the two states are not the same question.
 */

export interface QuotaRecord {
  readonly id: string;
  readonly invoiceCount: number;
  readonly quotaCount: number;
  readonly entitlementCount: number;
  readonly workspaceCount: number;
  readonly dispatchCount: number;
  readonly retentionCount: number;
  readonly subscriberCount: number;
  readonly state: 'invoice' | 'quota' | 'entitlement';
  readonly updatedAt: string;
}

export interface QuotaSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Collapses the invoice side of a quota, leaving the rest untouched. */
export function collapseInvoice(input: readonly QuotaRecord[]): QuotaRecord[] {
  return input
    .filter((row) => row.invoiceCount > 0)
    .map((row) => ({ ...row, invoiceCount: Math.max(0, row.invoiceCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Settles the quota side of a quota, leaving the rest untouched. */
export function settleQuota(input: readonly QuotaRecord[]): QuotaRecord[] {
  return input
    .filter((row) => row.quotaCount > 0)
    .map((row) => ({ ...row, quotaCount: Math.max(0, row.quotaCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Normalises the entitlement side of a quota, leaving the rest untouched. */
export function normaliseEntitlement(input: readonly QuotaRecord[]): QuotaRecord[] {
  return input
    .filter((row) => row.entitlementCount > 0)
    .map((row) => ({ ...row, entitlementCount: Math.max(0, row.entitlementCount - 1) }))
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
  "invoice": 0,
  "quota": 0,
  "entitlement": 0,
  "workspace": 0,
  "dispatch": 0,
  "retention": 0,
  "subscriber": 0
};

export function withDefaults(partial: Partial<QuotaRecord>): QuotaRecord {
  return { id: '', state: 'invoice', updatedAt: '', ...DEFAULTS, ...partial } as QuotaRecord;
}
