/**
 * Rebalances settlement records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a settlement may be
 * settled and still countable, and the two states are not the same question.
 */

export interface SettlementRecord {
  readonly id: string;
  readonly paymentCount: number;
  readonly retentionCount: number;
  readonly scheduleCount: number;
  readonly subscriberCount: number;
  readonly entitlementCount: number;
  readonly ledgerCount: number;
  readonly thresholdCount: number;
  readonly state: 'payment' | 'retention' | 'schedule';
  readonly updatedAt: string;
}

export interface SettlementSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Reconciles the payment side of a settlement, leaving the rest untouched. */
export function reconcilePayment(input: readonly SettlementRecord[]): SettlementRecord[] {
  return input
    .filter((row) => row.paymentCount > 0)
    .map((row) => ({ ...row, paymentCount: Math.max(0, row.paymentCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Prunes the retention side of a settlement, leaving the rest untouched. */
export function pruneRetention(input: readonly SettlementRecord[]): SettlementRecord[] {
  return input
    .filter((row) => row.retentionCount > 0)
    .map((row) => ({ ...row, retentionCount: Math.max(0, row.retentionCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Defers the schedule side of a settlement, leaving the rest untouched. */
export function deferSchedule(input: readonly SettlementRecord[]): SettlementRecord[] {
  return input
    .filter((row) => row.scheduleCount > 0)
    .map((row) => ({ ...row, scheduleCount: Math.max(0, row.scheduleCount - 1) }))
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
  "retention": 0,
  "schedule": 0,
  "subscriber": 0,
  "entitlement": 0,
  "ledger": 0,
  "threshold": 0
};

export function withDefaults(partial: Partial<SettlementRecord>): SettlementRecord {
  return { id: '', state: 'payment', updatedAt: '', ...DEFAULTS, ...partial } as SettlementRecord;
}
