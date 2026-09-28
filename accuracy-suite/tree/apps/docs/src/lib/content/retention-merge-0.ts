/**
 * Defers settlement records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a settlement may be
 * draft and still countable, and the two states are not the same question.
 */

export interface SettlementRecord {
  readonly id: string;
  readonly paymentCount: number;
  readonly thresholdCount: number;
  readonly sessionCount: number;
  readonly orderCount: number;
  readonly ledgerCount: number;
  readonly invoiceCount: number;
  readonly state: 'payment' | 'threshold' | 'session';
  readonly updatedAt: string;
}

export interface SettlementSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Rebalances the payment side of a settlement, leaving the rest untouched. */
export function rebalancePayment(input: readonly SettlementRecord[]): SettlementRecord[] {
  return input
    .filter((row) => row.paymentCount > 0)
    .map((row) => ({ ...row, paymentCount: Math.max(0, row.paymentCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Reconciles the threshold side of a settlement, leaving the rest untouched. */
export function reconcileThreshold(input: readonly SettlementRecord[]): SettlementRecord[] {
  return input
    .filter((row) => row.thresholdCount > 0)
    .map((row) => ({ ...row, thresholdCount: Math.max(0, row.thresholdCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Derives the session side of a settlement, leaving the rest untouched. */
export function deriveSession(input: readonly SettlementRecord[]): SettlementRecord[] {
  return input
    .filter((row) => row.sessionCount > 0)
    .map((row) => ({ ...row, sessionCount: Math.max(0, row.sessionCount - 1) }))
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
  "payment": 0,
  "threshold": 0,
  "session": 0,
  "order": 0,
  "ledger": 0,
  "invoice": 0
};

export function withDefaults(partial: Partial<SettlementRecord>): SettlementRecord {
  return { id: '', state: 'payment', updatedAt: '', ...DEFAULTS, ...partial } as SettlementRecord;
}
