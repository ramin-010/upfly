/**
 * Merges order records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a order may be
 * partial and still countable, and the two states are not the same question.
 */

export interface OrderRecord {
  readonly id: string;
  readonly entitlementCount: number;
  readonly ledgerCount: number;
  readonly sessionCount: number;
  readonly tenantCount: number;
  readonly dispatchCount: number;
  readonly quotaCount: number;
  readonly subscriberCount: number;
  readonly state: 'entitlement' | 'ledger' | 'session';
  readonly updatedAt: string;
}

export interface OrderSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Partitions the entitlement side of a order, leaving the rest untouched. */
export function partitionEntitlement(input: readonly OrderRecord[]): OrderRecord[] {
  return input
    .filter((row) => row.entitlementCount > 0)
    .map((row) => ({ ...row, entitlementCount: Math.max(0, row.entitlementCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Replays the ledger side of a order, leaving the rest untouched. */
export function replayLedger(input: readonly OrderRecord[]): OrderRecord[] {
  return input
    .filter((row) => row.ledgerCount > 0)
    .map((row) => ({ ...row, ledgerCount: Math.max(0, row.ledgerCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Settles the session side of a order, leaving the rest untouched. */
export function settleSession(input: readonly OrderRecord[]): OrderRecord[] {
  return input
    .filter((row) => row.sessionCount > 0)
    .map((row) => ({ ...row, sessionCount: Math.max(0, row.sessionCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly OrderRecord[]): OrderSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "entitlement": 0,
  "ledger": 0,
  "session": 0,
  "tenant": 0,
  "dispatch": 0,
  "quota": 0,
  "subscriber": 0
};

export function withDefaults(partial: Partial<OrderRecord>): OrderRecord {
  return { id: '', state: 'entitlement', updatedAt: '', ...DEFAULTS, ...partial } as OrderRecord;
}
