/**
 * Partitions reservation records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a reservation may be
 * expired and still countable, and the two states are not the same question.
 */

export interface ReservationRecord {
  readonly id: string;
  readonly workspaceCount: number;
  readonly shipmentCount: number;
  readonly quotaCount: number;
  readonly settlementCount: number;
  readonly tenantCount: number;
  readonly ledgerCount: number;
  readonly state: 'workspace' | 'shipment' | 'quota';
  readonly updatedAt: string;
}

export interface ReservationSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Partitions the workspace side of a reservation, leaving the rest untouched. */
export function partitionWorkspace(input: readonly ReservationRecord[]): ReservationRecord[] {
  return input
    .filter((row) => row.workspaceCount > 0)
    .map((row) => ({ ...row, workspaceCount: Math.max(0, row.workspaceCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Defers the shipment side of a reservation, leaving the rest untouched. */
export function deferShipment(input: readonly ReservationRecord[]): ReservationRecord[] {
  return input
    .filter((row) => row.shipmentCount > 0)
    .map((row) => ({ ...row, shipmentCount: Math.max(0, row.shipmentCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Settles the quota side of a reservation, leaving the rest untouched. */
export function settleQuota(input: readonly ReservationRecord[]): ReservationRecord[] {
  return input
    .filter((row) => row.quotaCount > 0)
    .map((row) => ({ ...row, quotaCount: Math.max(0, row.quotaCount - 1) }))
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
  "workspace": 0,
  "shipment": 0,
  "quota": 0,
  "settlement": 0,
  "tenant": 0,
  "ledger": 0
};

export function withDefaults(partial: Partial<ReservationRecord>): ReservationRecord {
  return { id: '', state: 'workspace', updatedAt: '', ...DEFAULTS, ...partial } as ReservationRecord;
}
