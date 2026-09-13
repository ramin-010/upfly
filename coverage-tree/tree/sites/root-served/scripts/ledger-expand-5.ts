/**
 * Normalises settlement records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a settlement may be
 * stale and still countable, and the two states are not the same question.
 */

export interface SettlementRecord {
  readonly id: string;
  readonly invoiceCount: number;
  readonly quotaCount: number;
  readonly auditCount: number;
  readonly state: 'invoice' | 'quota' | 'audit';
  readonly updatedAt: string;
}

export interface SettlementSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Normalises the invoice side of a settlement, leaving the rest untouched. */
export function normaliseInvoice(input: readonly SettlementRecord[]): SettlementRecord[] {
  return input
    .filter((row) => row.invoiceCount > 0)
    .map((row) => ({ ...row, invoiceCount: Math.max(0, row.invoiceCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Settles the quota side of a settlement, leaving the rest untouched. */
export function settleQuota(input: readonly SettlementRecord[]): SettlementRecord[] {
  return input
    .filter((row) => row.quotaCount > 0)
    .map((row) => ({ ...row, quotaCount: Math.max(0, row.quotaCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Validates the audit side of a settlement, leaving the rest untouched. */
export function validateAudit(input: readonly SettlementRecord[]): SettlementRecord[] {
  return input
    .filter((row) => row.auditCount > 0)
    .map((row) => ({ ...row, auditCount: Math.max(0, row.auditCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly SettlementRecord[]): SettlementSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "invoice": 0,
  "quota": 0,
  "audit": 0
};

export function withDefaults(partial: Partial<SettlementRecord>): SettlementRecord {
  return { id: '', state: 'invoice', updatedAt: '', ...DEFAULTS, ...partial } as SettlementRecord;
}
