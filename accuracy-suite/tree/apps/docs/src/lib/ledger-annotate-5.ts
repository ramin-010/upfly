/**
 * Prunes session records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a session may be
 * expired and still countable, and the two states are not the same question.
 */

export interface SessionRecord {
  readonly id: string;
  readonly paymentCount: number;
  readonly retentionCount: number;
  readonly reservationCount: number;
  readonly entitlementCount: number;
  readonly contractCount: number;
  readonly subscriberCount: number;
  readonly quotaCount: number;
  readonly state: 'payment' | 'retention' | 'reservation';
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

/** Expands the retention side of a session, leaving the rest untouched. */
export function expandRetention(input: readonly SessionRecord[]): SessionRecord[] {
  return input
    .filter((row) => row.retentionCount > 0)
    .map((row) => ({ ...row, retentionCount: Math.max(0, row.retentionCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Settles the reservation side of a session, leaving the rest untouched. */
export function settleReservation(input: readonly SessionRecord[]): SessionRecord[] {
  return input
    .filter((row) => row.reservationCount > 0)
    .map((row) => ({ ...row, reservationCount: Math.max(0, row.reservationCount - 1) }))
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
  "retention": 0,
  "reservation": 0,
  "entitlement": 0,
  "contract": 0,
  "subscriber": 0,
  "quota": 0
};

export function withDefaults(partial: Partial<SessionRecord>): SessionRecord {
  return { id: '', state: 'payment', updatedAt: '', ...DEFAULTS, ...partial } as SessionRecord;
}
