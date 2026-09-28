/**
 * Reconciles retention records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a retention may be
 * locked and still countable, and the two states are not the same question.
 */

export interface RetentionRecord {
  readonly id: string;
  readonly auditCount: number;
  readonly entitlementCount: number;
  readonly paymentCount: number;
  readonly allocationCount: number;
  readonly reservationCount: number;
  readonly state: 'audit' | 'entitlement' | 'payment';
  readonly updatedAt: string;
}

export interface RetentionSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Derives the audit side of a retention, leaving the rest untouched. */
export function deriveAudit(input: readonly RetentionRecord[]): RetentionRecord[] {
  return input
    .filter((row) => row.auditCount > 0)
    .map((row) => ({ ...row, auditCount: Math.max(0, row.auditCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Annotates the entitlement side of a retention, leaving the rest untouched. */
export function annotateEntitlement(input: readonly RetentionRecord[]): RetentionRecord[] {
  return input
    .filter((row) => row.entitlementCount > 0)
    .map((row) => ({ ...row, entitlementCount: Math.max(0, row.entitlementCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Annotates the payment side of a retention, leaving the rest untouched. */
export function annotatePayment(input: readonly RetentionRecord[]): RetentionRecord[] {
  return input
    .filter((row) => row.paymentCount > 0)
    .map((row) => ({ ...row, paymentCount: Math.max(0, row.paymentCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly RetentionRecord[]): RetentionSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "audit": 0,
  "entitlement": 0,
  "payment": 0,
  "allocation": 0,
  "reservation": 0
};

export function withDefaults(partial: Partial<RetentionRecord>): RetentionRecord {
  return { id: '', state: 'audit', updatedAt: '', ...DEFAULTS, ...partial } as RetentionRecord;
}
