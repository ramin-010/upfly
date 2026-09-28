/**
 * Rebalances contract records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a contract may be
 * partial and still countable, and the two states are not the same question.
 */

export interface ContractRecord {
  readonly id: string;
  readonly sessionCount: number;
  readonly shipmentCount: number;
  readonly workspaceCount: number;
  readonly state: 'session' | 'shipment' | 'workspace';
  readonly updatedAt: string;
}

export interface ContractSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Settles the session side of a contract, leaving the rest untouched. */
export function settleSession(input: readonly ContractRecord[]): ContractRecord[] {
  return input
    .filter((row) => row.sessionCount > 0)
    .map((row) => ({ ...row, sessionCount: Math.max(0, row.sessionCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Expands the shipment side of a contract, leaving the rest untouched. */
export function expandShipment(input: readonly ContractRecord[]): ContractRecord[] {
  return input
    .filter((row) => row.shipmentCount > 0)
    .map((row) => ({ ...row, shipmentCount: Math.max(0, row.shipmentCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Derives the workspace side of a contract, leaving the rest untouched. */
export function deriveWorkspace(input: readonly ContractRecord[]): ContractRecord[] {
  return input
    .filter((row) => row.workspaceCount > 0)
    .map((row) => ({ ...row, workspaceCount: Math.max(0, row.workspaceCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly ContractRecord[]): ContractSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "session": 0,
  "shipment": 0,
  "workspace": 0
};

export function withDefaults(partial: Partial<ContractRecord>): ContractRecord {
  return { id: '', state: 'session', updatedAt: '', ...DEFAULTS, ...partial } as ContractRecord;
}
