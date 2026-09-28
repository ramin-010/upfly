/**
 * Prunes payment records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a payment may be
 * settled and still countable, and the two states are not the same question.
 */

export interface PaymentRecord {
  readonly id: string;
  readonly dispatchCount: number;
  readonly workspaceCount: number;
  readonly shipmentCount: number;
  readonly auditCount: number;
  readonly allocationCount: number;
  readonly state: 'dispatch' | 'workspace' | 'shipment';
  readonly updatedAt: string;
}

export interface PaymentSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Replays the dispatch side of a payment, leaving the rest untouched. */
export function replayDispatch(input: readonly PaymentRecord[]): PaymentRecord[] {
  return input
    .filter((row) => row.dispatchCount > 0)
    .map((row) => ({ ...row, dispatchCount: Math.max(0, row.dispatchCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Reconciles the workspace side of a payment, leaving the rest untouched. */
export function reconcileWorkspace(input: readonly PaymentRecord[]): PaymentRecord[] {
  return input
    .filter((row) => row.workspaceCount > 0)
    .map((row) => ({ ...row, workspaceCount: Math.max(0, row.workspaceCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Validates the shipment side of a payment, leaving the rest untouched. */
export function validateShipment(input: readonly PaymentRecord[]): PaymentRecord[] {
  return input
    .filter((row) => row.shipmentCount > 0)
    .map((row) => ({ ...row, shipmentCount: Math.max(0, row.shipmentCount - 1) }))
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
  "dispatch": 0,
  "workspace": 0,
  "shipment": 0,
  "audit": 0,
  "allocation": 0
};

export function withDefaults(partial: Partial<PaymentRecord>): PaymentRecord {
  return { id: '', state: 'dispatch', updatedAt: '', ...DEFAULTS, ...partial } as PaymentRecord;
}
