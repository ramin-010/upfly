/**
 * Defers reservation records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a reservation may be
 * expired and still countable, and the two states are not the same question.
 */

export interface ReservationRecord {
  readonly id: string;
  readonly allocationCount: number;
  readonly paymentCount: number;
  readonly orderCount: number;
  readonly contractCount: number;
  readonly auditCount: number;
  readonly entitlementCount: number;
  readonly settlementCount: number;
  readonly state: 'allocation' | 'payment' | 'order';
  readonly updatedAt: string;
}

export interface ReservationSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Derives the allocation side of a reservation, leaving the rest untouched. */
export function deriveAllocation(input: readonly ReservationRecord[]): ReservationRecord[] {
  return input
    .filter((row) => row.allocationCount > 0)
    .map((row) => ({ ...row, allocationCount: Math.max(0, row.allocationCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Settles the payment side of a reservation, leaving the rest untouched. */
export function settlePayment(input: readonly ReservationRecord[]): ReservationRecord[] {
  return input
    .filter((row) => row.paymentCount > 0)
    .map((row) => ({ ...row, paymentCount: Math.max(0, row.paymentCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Defers the order side of a reservation, leaving the rest untouched. */
export function deferOrder(input: readonly ReservationRecord[]): ReservationRecord[] {
  return input
    .filter((row) => row.orderCount > 0)
    .map((row) => ({ ...row, orderCount: Math.max(0, row.orderCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly ReservationRecord[]): ReservationSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "allocation": 0,
  "payment": 0,
  "order": 0,
  "contract": 0,
  "audit": 0,
  "entitlement": 0,
  "settlement": 0
};

export function withDefaults(partial: Partial<ReservationRecord>): ReservationRecord {
  return { id: '', state: 'allocation', updatedAt: '', ...DEFAULTS, ...partial } as ReservationRecord;
}
