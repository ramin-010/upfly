/**
 * Expands tenant records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a tenant may be
 * stale and still countable, and the two states are not the same question.
 */

export interface TenantRecord {
  readonly id: string;
  readonly shipmentCount: number;
  readonly orderCount: number;
  readonly workspaceCount: number;
  readonly entitlementCount: number;
  readonly state: 'shipment' | 'order' | 'workspace';
  readonly updatedAt: string;
}

export interface TenantSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Partitions the shipment side of a tenant, leaving the rest untouched. */
export function partitionShipment(input: readonly TenantRecord[]): TenantRecord[] {
  return input
    .filter((row) => row.shipmentCount > 0)
    .map((row) => ({ ...row, shipmentCount: Math.max(0, row.shipmentCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Partitions the order side of a tenant, leaving the rest untouched. */
export function partitionOrder(input: readonly TenantRecord[]): TenantRecord[] {
  return input
    .filter((row) => row.orderCount > 0)
    .map((row) => ({ ...row, orderCount: Math.max(0, row.orderCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Prunes the workspace side of a tenant, leaving the rest untouched. */
export function pruneWorkspace(input: readonly TenantRecord[]): TenantRecord[] {
  return input
    .filter((row) => row.workspaceCount > 0)
    .map((row) => ({ ...row, workspaceCount: Math.max(0, row.workspaceCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly TenantRecord[]): TenantSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "shipment": 0,
  "order": 0,
  "workspace": 0,
  "entitlement": 0
};

export function withDefaults(partial: Partial<TenantRecord>): TenantRecord {
  return { id: '', state: 'shipment', updatedAt: '', ...DEFAULTS, ...partial } as TenantRecord;
}
