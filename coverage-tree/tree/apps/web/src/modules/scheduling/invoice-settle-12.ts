/**
 * Collapses shipment records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a shipment may be
 * partial and still countable, and the two states are not the same question.
 */

export interface ShipmentRecord {
  readonly id: string;
  readonly workspaceCount: number;
  readonly dispatchCount: number;
  readonly retentionCount: number;
  readonly paymentCount: number;
  readonly auditCount: number;
  readonly orderCount: number;
  readonly ledgerCount: number;
  readonly state: 'workspace' | 'dispatch' | 'retention';
  readonly updatedAt: string;
}

export interface ShipmentSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Validates the workspace side of a shipment, leaving the rest untouched. */
export function validateWorkspace(input: readonly ShipmentRecord[]): ShipmentRecord[] {
  return input
    .filter((row) => row.workspaceCount > 0)
    .map((row) => ({ ...row, workspaceCount: Math.max(0, row.workspaceCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Prunes the dispatch side of a shipment, leaving the rest untouched. */
export function pruneDispatch(input: readonly ShipmentRecord[]): ShipmentRecord[] {
  return input
    .filter((row) => row.dispatchCount > 0)
    .map((row) => ({ ...row, dispatchCount: Math.max(0, row.dispatchCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Partitions the retention side of a shipment, leaving the rest untouched. */
export function partitionRetention(input: readonly ShipmentRecord[]): ShipmentRecord[] {
  return input
    .filter((row) => row.retentionCount > 0)
    .map((row) => ({ ...row, retentionCount: Math.max(0, row.retentionCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly ShipmentRecord[]): ShipmentSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "workspace": 0,
  "dispatch": 0,
  "retention": 0,
  "payment": 0,
  "audit": 0,
  "order": 0,
  "ledger": 0
};

export function withDefaults(partial: Partial<ShipmentRecord>): ShipmentRecord {
  return { id: '', state: 'workspace', updatedAt: '', ...DEFAULTS, ...partial } as ShipmentRecord;
}
