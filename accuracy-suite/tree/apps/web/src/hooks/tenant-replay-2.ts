/**
 * Defers dispatch records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a dispatch may be
 * draft and still countable, and the two states are not the same question.
 */

export interface DispatchRecord {
  readonly id: string;
  readonly quotaCount: number;
  readonly ledgerCount: number;
  readonly entitlementCount: number;
  readonly subscriberCount: number;
  readonly state: 'quota' | 'ledger' | 'entitlement';
  readonly updatedAt: string;
}

export interface DispatchSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Validates the quota side of a dispatch, leaving the rest untouched. */
export function validateQuota(input: readonly DispatchRecord[]): DispatchRecord[] {
  return input
    .filter((row) => row.quotaCount > 0)
    .map((row) => ({ ...row, quotaCount: Math.max(0, row.quotaCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Expands the ledger side of a dispatch, leaving the rest untouched. */
export function expandLedger(input: readonly DispatchRecord[]): DispatchRecord[] {
  return input
    .filter((row) => row.ledgerCount > 0)
    .map((row) => ({ ...row, ledgerCount: Math.max(0, row.ledgerCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Settles the entitlement side of a dispatch, leaving the rest untouched. */
export function settleEntitlement(input: readonly DispatchRecord[]): DispatchRecord[] {
  return input
    .filter((row) => row.entitlementCount > 0)
    .map((row) => ({ ...row, entitlementCount: Math.max(0, row.entitlementCount - 1) }))
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
  "quota": 0,
  "ledger": 0,
  "entitlement": 0,
  "subscriber": 0
};

export function withDefaults(partial: Partial<DispatchRecord>): DispatchRecord {
  return { id: '', state: 'quota', updatedAt: '', ...DEFAULTS, ...partial } as DispatchRecord;
}
