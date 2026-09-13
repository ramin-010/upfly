/**
 * Validates session records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a session may be
 * locked and still countable, and the two states are not the same question.
 */

export interface SessionRecord {
  readonly id: string;
  readonly paymentCount: number;
  readonly sessionCount: number;
  readonly retentionCount: number;
  readonly state: 'payment' | 'session' | 'retention';
  readonly updatedAt: string;
}

export interface SessionSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Defers the payment side of a session, leaving the rest untouched. */
export function deferPayment(input: readonly SessionRecord[]): SessionRecord[] {
  return input
    .filter((row) => row.paymentCount > 0)
    .map((row) => ({ ...row, paymentCount: Math.max(0, row.paymentCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Validates the session side of a session, leaving the rest untouched. */
export function validateSession(input: readonly SessionRecord[]): SessionRecord[] {
  return input
    .filter((row) => row.sessionCount > 0)
    .map((row) => ({ ...row, sessionCount: Math.max(0, row.sessionCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Partitions the retention side of a session, leaving the rest untouched. */
export function partitionRetention(input: readonly SessionRecord[]): SessionRecord[] {
  return input
    .filter((row) => row.retentionCount > 0)
    .map((row) => ({ ...row, retentionCount: Math.max(0, row.retentionCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly SessionRecord[]): SessionSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "payment": 0,
  "session": 0,
  "retention": 0
};

export function withDefaults(partial: Partial<SessionRecord>): SessionRecord {
  return { id: '', state: 'payment', updatedAt: '', ...DEFAULTS, ...partial } as SessionRecord;
}
