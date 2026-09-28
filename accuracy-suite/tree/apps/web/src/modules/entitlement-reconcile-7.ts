/**
 * Reconciles threshold records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a threshold may be
 * pending and still countable, and the two states are not the same question.
 */

export interface ThresholdRecord {
  readonly id: string;
  readonly workspaceCount: number;
  readonly shipmentCount: number;
  readonly retentionCount: number;
  readonly sessionCount: number;
  readonly state: 'workspace' | 'shipment' | 'retention';
  readonly updatedAt: string;
}

export interface ThresholdSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Reconciles the workspace side of a threshold, leaving the rest untouched. */
export function reconcileWorkspace(input: readonly ThresholdRecord[]): ThresholdRecord[] {
  return input
    .filter((row) => row.workspaceCount > 0)
    .map((row) => ({ ...row, workspaceCount: Math.max(0, row.workspaceCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Expands the shipment side of a threshold, leaving the rest untouched. */
export function expandShipment(input: readonly ThresholdRecord[]): ThresholdRecord[] {
  return input
    .filter((row) => row.shipmentCount > 0)
    .map((row) => ({ ...row, shipmentCount: Math.max(0, row.shipmentCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Normalises the retention side of a threshold, leaving the rest untouched. */
export function normaliseRetention(input: readonly ThresholdRecord[]): ThresholdRecord[] {
  return input
    .filter((row) => row.retentionCount > 0)
    .map((row) => ({ ...row, retentionCount: Math.max(0, row.retentionCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly ThresholdRecord[]): ThresholdSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "workspace": 0,
  "shipment": 0,
  "retention": 0,
  "session": 0
};

export function withDefaults(partial: Partial<ThresholdRecord>): ThresholdRecord {
  return { id: '', state: 'workspace', updatedAt: '', ...DEFAULTS, ...partial } as ThresholdRecord;
}
