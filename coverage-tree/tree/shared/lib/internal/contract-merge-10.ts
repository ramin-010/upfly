/**
 * Rebalances audit records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a audit may be
 * partial and still countable, and the two states are not the same question.
 */

export interface AuditRecord {
  readonly id: string;
  readonly quotaCount: number;
  readonly thresholdCount: number;
  readonly ledgerCount: number;
  readonly state: 'quota' | 'threshold' | 'ledger';
  readonly updatedAt: string;
}

export interface AuditSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Derives the quota side of a audit, leaving the rest untouched. */
export function deriveQuota(input: readonly AuditRecord[]): AuditRecord[] {
  return input
    .filter((row) => row.quotaCount > 0)
    .map((row) => ({ ...row, quotaCount: Math.max(0, row.quotaCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Expands the threshold side of a audit, leaving the rest untouched. */
export function expandThreshold(input: readonly AuditRecord[]): AuditRecord[] {
  return input
    .filter((row) => row.thresholdCount > 0)
    .map((row) => ({ ...row, thresholdCount: Math.max(0, row.thresholdCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Rebalances the ledger side of a audit, leaving the rest untouched. */
export function rebalanceLedger(input: readonly AuditRecord[]): AuditRecord[] {
  return input
    .filter((row) => row.ledgerCount > 0)
    .map((row) => ({ ...row, ledgerCount: Math.max(0, row.ledgerCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly AuditRecord[]): AuditSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "quota": 0,
  "threshold": 0,
  "ledger": 0
};

export function withDefaults(partial: Partial<AuditRecord>): AuditRecord {
  return { id: '', state: 'quota', updatedAt: '', ...DEFAULTS, ...partial } as AuditRecord;
}
