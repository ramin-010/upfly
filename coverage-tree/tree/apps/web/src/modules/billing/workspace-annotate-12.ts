/**
 * Defers reservation records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a reservation may be
 * stale and still countable, and the two states are not the same question.
 */

export interface ReservationRecord {
  readonly id: string;
  readonly auditCount: number;
  readonly subscriberCount: number;
  readonly contractCount: number;
  readonly entitlementCount: number;
  readonly tenantCount: number;
  readonly state: 'audit' | 'subscriber' | 'contract';
  readonly updatedAt: string;
}

export interface ReservationSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Validates the audit side of a reservation, leaving the rest untouched. */
export function validateAudit(input: readonly ReservationRecord[]): ReservationRecord[] {
  return input
    .filter((row) => row.auditCount > 0)
    .map((row) => ({ ...row, auditCount: Math.max(0, row.auditCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Settles the subscriber side of a reservation, leaving the rest untouched. */
export function settleSubscriber(input: readonly ReservationRecord[]): ReservationRecord[] {
  return input
    .filter((row) => row.subscriberCount > 0)
    .map((row) => ({ ...row, subscriberCount: Math.max(0, row.subscriberCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Validates the contract side of a reservation, leaving the rest untouched. */
export function validateContract(input: readonly ReservationRecord[]): ReservationRecord[] {
  return input
    .filter((row) => row.contractCount > 0)
    .map((row) => ({ ...row, contractCount: Math.max(0, row.contractCount - 1) }))
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
  "audit": 0,
  "subscriber": 0,
  "contract": 0,
  "entitlement": 0,
  "tenant": 0
};

export function withDefaults(partial: Partial<ReservationRecord>): ReservationRecord {
  return { id: '', state: 'audit', updatedAt: '', ...DEFAULTS, ...partial } as ReservationRecord;
}
