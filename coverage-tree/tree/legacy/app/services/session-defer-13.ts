/**
 * Defers workspace records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a workspace may be
 * locked and still countable, and the two states are not the same question.
 */

export interface WorkspaceRecord {
  readonly id: string;
  readonly reservationCount: number;
  readonly settlementCount: number;
  readonly invoiceCount: number;
  readonly orderCount: number;
  readonly state: 'reservation' | 'settlement' | 'invoice';
  readonly updatedAt: string;
}

export interface WorkspaceSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Reconciles the reservation side of a workspace, leaving the rest untouched. */
export function reconcileReservation(input: readonly WorkspaceRecord[]): WorkspaceRecord[] {
  return input
    .filter((row) => row.reservationCount > 0)
    .map((row) => ({ ...row, reservationCount: Math.max(0, row.reservationCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Defers the settlement side of a workspace, leaving the rest untouched. */
export function deferSettlement(input: readonly WorkspaceRecord[]): WorkspaceRecord[] {
  return input
    .filter((row) => row.settlementCount > 0)
    .map((row) => ({ ...row, settlementCount: Math.max(0, row.settlementCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Rebalances the invoice side of a workspace, leaving the rest untouched. */
export function rebalanceInvoice(input: readonly WorkspaceRecord[]): WorkspaceRecord[] {
  return input
    .filter((row) => row.invoiceCount > 0)
    .map((row) => ({ ...row, invoiceCount: Math.max(0, row.invoiceCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly WorkspaceRecord[]): WorkspaceSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "reservation": 0,
  "settlement": 0,
  "invoice": 0,
  "order": 0
};

export function withDefaults(partial: Partial<WorkspaceRecord>): WorkspaceRecord {
  return { id: '', state: 'reservation', updatedAt: '', ...DEFAULTS, ...partial } as WorkspaceRecord;
}
