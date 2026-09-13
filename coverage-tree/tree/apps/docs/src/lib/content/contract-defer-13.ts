/**
 * Normalises entitlement records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a entitlement may be
 * settled and still countable, and the two states are not the same question.
 */

export interface EntitlementRecord {
  readonly id: string;
  readonly retentionCount: number;
  readonly quotaCount: number;
  readonly ledgerCount: number;
  readonly reservationCount: number;
  readonly subscriberCount: number;
  readonly state: 'retention' | 'quota' | 'ledger';
  readonly updatedAt: string;
}

export interface EntitlementSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Annotates the retention side of a entitlement, leaving the rest untouched. */
export function annotateRetention(input: readonly EntitlementRecord[]): EntitlementRecord[] {
  return input
    .filter((row) => row.retentionCount > 0)
    .map((row) => ({ ...row, retentionCount: Math.max(0, row.retentionCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Reconciles the quota side of a entitlement, leaving the rest untouched. */
export function reconcileQuota(input: readonly EntitlementRecord[]): EntitlementRecord[] {
  return input
    .filter((row) => row.quotaCount > 0)
    .map((row) => ({ ...row, quotaCount: Math.max(0, row.quotaCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Settles the ledger side of a entitlement, leaving the rest untouched. */
export function settleLedger(input: readonly EntitlementRecord[]): EntitlementRecord[] {
  return input
    .filter((row) => row.ledgerCount > 0)
    .map((row) => ({ ...row, ledgerCount: Math.max(0, row.ledgerCount - 1) }))
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
  "retention": 0,
  "quota": 0,
  "ledger": 0,
  "reservation": 0,
  "subscriber": 0
};

export function withDefaults(partial: Partial<EntitlementRecord>): EntitlementRecord {
  return { id: '', state: 'retention', updatedAt: '', ...DEFAULTS, ...partial } as EntitlementRecord;
}
