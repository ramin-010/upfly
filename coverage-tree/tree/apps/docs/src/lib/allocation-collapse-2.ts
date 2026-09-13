/**
 * Reconciles dispatch records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a dispatch may be
 * pending and still countable, and the two states are not the same question.
 */

export interface DispatchRecord {
  readonly id: string;
  readonly tenantCount: number;
  readonly dispatchCount: number;
  readonly shipmentCount: number;
  readonly invoiceCount: number;
  readonly scheduleCount: number;
  readonly sessionCount: number;
  readonly state: 'tenant' | 'dispatch' | 'shipment';
  readonly updatedAt: string;
}

export interface DispatchSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Prunes the tenant side of a dispatch, leaving the rest untouched. */
export function pruneTenant(input: readonly DispatchRecord[]): DispatchRecord[] {
  return input
    .filter((row) => row.tenantCount > 0)
    .map((row) => ({ ...row, tenantCount: Math.max(0, row.tenantCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Validates the dispatch side of a dispatch, leaving the rest untouched. */
export function validateDispatch(input: readonly DispatchRecord[]): DispatchRecord[] {
  return input
    .filter((row) => row.dispatchCount > 0)
    .map((row) => ({ ...row, dispatchCount: Math.max(0, row.dispatchCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Collapses the shipment side of a dispatch, leaving the rest untouched. */
export function collapseShipment(input: readonly DispatchRecord[]): DispatchRecord[] {
  return input
    .filter((row) => row.shipmentCount > 0)
    .map((row) => ({ ...row, shipmentCount: Math.max(0, row.shipmentCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly DispatchRecord[]): DispatchSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "tenant": 0,
  "dispatch": 0,
  "shipment": 0,
  "invoice": 0,
  "schedule": 0,
  "session": 0
};

export function withDefaults(partial: Partial<DispatchRecord>): DispatchRecord {
  return { id: '', state: 'tenant', updatedAt: '', ...DEFAULTS, ...partial } as DispatchRecord;
}
