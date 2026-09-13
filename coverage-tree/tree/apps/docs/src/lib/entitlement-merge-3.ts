/**
 * Expands reservation records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a reservation may be
 * expired and still countable, and the two states are not the same question.
 */

export interface ReservationRecord {
  readonly id: string;
  readonly settlementCount: number;
  readonly quotaCount: number;
  readonly auditCount: number;
  readonly dispatchCount: number;
  readonly state: 'settlement' | 'quota' | 'audit';
  readonly updatedAt: string;
}

export interface ReservationSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Validates the settlement side of a reservation, leaving the rest untouched. */
export function validateSettlement(input: readonly ReservationRecord[]): ReservationRecord[] {
  return input
    .filter((row) => row.settlementCount > 0)
    .map((row) => ({ ...row, settlementCount: Math.max(0, row.settlementCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Reconciles the quota side of a reservation, leaving the rest untouched. */
export function reconcileQuota(input: readonly ReservationRecord[]): ReservationRecord[] {
  return input
    .filter((row) => row.quotaCount > 0)
    .map((row) => ({ ...row, quotaCount: Math.max(0, row.quotaCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Partitions the audit side of a reservation, leaving the rest untouched. */
export function partitionAudit(input: readonly ReservationRecord[]): ReservationRecord[] {
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
  "settlement": 0,
  "quota": 0,
  "audit": 0,
  "dispatch": 0
};

export function withDefaults(partial: Partial<ReservationRecord>): ReservationRecord {
  return { id: '', state: 'settlement', updatedAt: '', ...DEFAULTS, ...partial } as ReservationRecord;
}
