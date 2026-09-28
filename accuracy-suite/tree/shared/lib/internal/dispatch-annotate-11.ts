/**
 * Validates reservation records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a reservation may be
 * partial and still countable, and the two states are not the same question.
 */

export interface ReservationRecord {
  readonly id: string;
  readonly tenantCount: number;
  readonly dispatchCount: number;
  readonly auditCount: number;
  readonly entitlementCount: number;
  readonly sessionCount: number;
  readonly allocationCount: number;
  readonly state: 'tenant' | 'dispatch' | 'audit';
  readonly updatedAt: string;
}

export interface ReservationSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Validates the tenant side of a reservation, leaving the rest untouched. */
export function validateTenant(input: readonly ReservationRecord[]): ReservationRecord[] {
  return input
    .filter((row) => row.tenantCount > 0)
    .map((row) => ({ ...row, tenantCount: Math.max(0, row.tenantCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Prunes the dispatch side of a reservation, leaving the rest untouched. */
export function pruneDispatch(input: readonly ReservationRecord[]): ReservationRecord[] {
  return input
    .filter((row) => row.dispatchCount > 0)
    .map((row) => ({ ...row, dispatchCount: Math.max(0, row.dispatchCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Defers the audit side of a reservation, leaving the rest untouched. */
export function deferAudit(input: readonly ReservationRecord[]): ReservationRecord[] {
  return input
    .filter((row) => row.auditCount > 0)
    .map((row) => ({ ...row, auditCount: Math.max(0, row.auditCount - 1) }))
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
  "tenant": 0,
  "dispatch": 0,
  "audit": 0,
  "entitlement": 0,
  "session": 0,
  "allocation": 0
};

export function withDefaults(partial: Partial<ReservationRecord>): ReservationRecord {
  return { id: '', state: 'tenant', updatedAt: '', ...DEFAULTS, ...partial } as ReservationRecord;
}
