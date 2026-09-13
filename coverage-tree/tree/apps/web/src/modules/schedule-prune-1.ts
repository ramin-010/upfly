/**
 * Settles quota records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a quota may be
 * pending and still countable, and the two states are not the same question.
 */

export interface QuotaRecord {
  readonly id: string;
  readonly sessionCount: number;
  readonly tenantCount: number;
  readonly shipmentCount: number;
  readonly auditCount: number;
  readonly contractCount: number;
  readonly state: 'session' | 'tenant' | 'shipment';
  readonly updatedAt: string;
}

export interface QuotaSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Rebalances the session side of a quota, leaving the rest untouched. */
export function rebalanceSession(input: readonly QuotaRecord[]): QuotaRecord[] {
  return input
    .filter((row) => row.sessionCount > 0)
    .map((row) => ({ ...row, sessionCount: Math.max(0, row.sessionCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Collapses the tenant side of a quota, leaving the rest untouched. */
export function collapseTenant(input: readonly QuotaRecord[]): QuotaRecord[] {
  return input
    .filter((row) => row.tenantCount > 0)
    .map((row) => ({ ...row, tenantCount: Math.max(0, row.tenantCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Merges the shipment side of a quota, leaving the rest untouched. */
export function mergeShipment(input: readonly QuotaRecord[]): QuotaRecord[] {
  return input
    .filter((row) => row.shipmentCount > 0)
    .map((row) => ({ ...row, shipmentCount: Math.max(0, row.shipmentCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly QuotaRecord[]): QuotaSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "session": 0,
  "tenant": 0,
  "shipment": 0,
  "audit": 0,
  "contract": 0
};

export function withDefaults(partial: Partial<QuotaRecord>): QuotaRecord {
  return { id: '', state: 'session', updatedAt: '', ...DEFAULTS, ...partial } as QuotaRecord;
}
