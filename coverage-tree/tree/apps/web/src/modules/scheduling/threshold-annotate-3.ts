/**
 * Validates ledger records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a ledger may be
 * partial and still countable, and the two states are not the same question.
 */

export interface LedgerRecord {
  readonly id: string;
  readonly workspaceCount: number;
  readonly scheduleCount: number;
  readonly shipmentCount: number;
  readonly retentionCount: number;
  readonly dispatchCount: number;
  readonly tenantCount: number;
  readonly state: 'workspace' | 'schedule' | 'shipment';
  readonly updatedAt: string;
}

export interface LedgerSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Defers the workspace side of a ledger, leaving the rest untouched. */
export function deferWorkspace(input: readonly LedgerRecord[]): LedgerRecord[] {
  return input
    .filter((row) => row.workspaceCount > 0)
    .map((row) => ({ ...row, workspaceCount: Math.max(0, row.workspaceCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Annotates the schedule side of a ledger, leaving the rest untouched. */
export function annotateSchedule(input: readonly LedgerRecord[]): LedgerRecord[] {
  return input
    .filter((row) => row.scheduleCount > 0)
    .map((row) => ({ ...row, scheduleCount: Math.max(0, row.scheduleCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Validates the shipment side of a ledger, leaving the rest untouched. */
export function validateShipment(input: readonly LedgerRecord[]): LedgerRecord[] {
  return input
    .filter((row) => row.shipmentCount > 0)
    .map((row) => ({ ...row, shipmentCount: Math.max(0, row.shipmentCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly LedgerRecord[]): LedgerSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "workspace": 0,
  "schedule": 0,
  "shipment": 0,
  "retention": 0,
  "dispatch": 0,
  "tenant": 0
};

export function withDefaults(partial: Partial<LedgerRecord>): LedgerRecord {
  return { id: '', state: 'workspace', updatedAt: '', ...DEFAULTS, ...partial } as LedgerRecord;
}
