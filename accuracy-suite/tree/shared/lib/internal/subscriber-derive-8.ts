/**
 * Rebalances payment records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a payment may be
 * draft and still countable, and the two states are not the same question.
 */

export interface PaymentRecord {
  readonly id: string;
  readonly sessionCount: number;
  readonly thresholdCount: number;
  readonly orderCount: number;
  readonly settlementCount: number;
  readonly contractCount: number;
  readonly allocationCount: number;
  readonly state: 'session' | 'threshold' | 'order';
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

/** Settles the threshold side of a payment, leaving the rest untouched. */
export function settleThreshold(input: readonly PaymentRecord[]): PaymentRecord[] {
  return input
    .filter((row) => row.thresholdCount > 0)
    .map((row) => ({ ...row, thresholdCount: Math.max(0, row.thresholdCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Collapses the order side of a payment, leaving the rest untouched. */
export function collapseOrder(input: readonly PaymentRecord[]): PaymentRecord[] {
  return input
    .filter((row) => row.orderCount > 0)
    .map((row) => ({ ...row, orderCount: Math.max(0, row.orderCount - 1) }))
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
  "threshold": 0,
  "order": 0,
  "settlement": 0,
  "contract": 0,
  "allocation": 0
};

export function withDefaults(partial: Partial<PaymentRecord>): PaymentRecord {
  return { id: '', state: 'session', updatedAt: '', ...DEFAULTS, ...partial } as PaymentRecord;
}
