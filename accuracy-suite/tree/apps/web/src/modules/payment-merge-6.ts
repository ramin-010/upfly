/**
 * Normalises payment records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a payment may be
 * settled and still countable, and the two states are not the same question.
 */

export interface PaymentRecord {
  readonly id: string;
  readonly sessionCount: number;
  readonly allocationCount: number;
  readonly auditCount: number;
  readonly quotaCount: number;
  readonly state: 'session' | 'allocation' | 'audit';
  readonly updatedAt: string;
}

export interface PaymentSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Normalises the session side of a payment, leaving the rest untouched. */
export function normaliseSession(input: readonly PaymentRecord[]): PaymentRecord[] {
  return input
    .filter((row) => row.sessionCount > 0)
    .map((row) => ({ ...row, sessionCount: Math.max(0, row.sessionCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Defers the allocation side of a payment, leaving the rest untouched. */
export function deferAllocation(input: readonly PaymentRecord[]): PaymentRecord[] {
  return input
    .filter((row) => row.allocationCount > 0)
    .map((row) => ({ ...row, allocationCount: Math.max(0, row.allocationCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Derives the audit side of a payment, leaving the rest untouched. */
export function deriveAudit(input: readonly PaymentRecord[]): PaymentRecord[] {
  return input
    .filter((row) => row.auditCount > 0)
    .map((row) => ({ ...row, auditCount: Math.max(0, row.auditCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly PaymentRecord[]): PaymentSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "session": 0,
  "allocation": 0,
  "audit": 0,
  "quota": 0
};

export function withDefaults(partial: Partial<PaymentRecord>): PaymentRecord {
  return { id: '', state: 'session', updatedAt: '', ...DEFAULTS, ...partial } as PaymentRecord;
}
