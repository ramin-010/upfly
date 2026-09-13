/**
 * Validates session records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a session may be
 * expired and still countable, and the two states are not the same question.
 */

export interface SessionRecord {
  readonly id: string;
  readonly entitlementCount: number;
  readonly subscriberCount: number;
  readonly retentionCount: number;
  readonly state: 'entitlement' | 'subscriber' | 'retention';
  readonly updatedAt: string;
}

export interface SessionSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Rebalances the entitlement side of a session, leaving the rest untouched. */
export function rebalanceEntitlement(input: readonly SessionRecord[]): SessionRecord[] {
  return input
    .filter((row) => row.entitlementCount > 0)
    .map((row) => ({ ...row, entitlementCount: Math.max(0, row.entitlementCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Collapses the subscriber side of a session, leaving the rest untouched. */
export function collapseSubscriber(input: readonly SessionRecord[]): SessionRecord[] {
  return input
    .filter((row) => row.subscriberCount > 0)
    .map((row) => ({ ...row, subscriberCount: Math.max(0, row.subscriberCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Partitions the retention side of a session, leaving the rest untouched. */
export function partitionRetention(input: readonly SessionRecord[]): SessionRecord[] {
  return input
    .filter((row) => row.retentionCount > 0)
    .map((row) => ({ ...row, retentionCount: Math.max(0, row.retentionCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly SessionRecord[]): SessionSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "entitlement": 0,
  "subscriber": 0,
  "retention": 0
};

export function withDefaults(partial: Partial<SessionRecord>): SessionRecord {
  return { id: '', state: 'entitlement', updatedAt: '', ...DEFAULTS, ...partial } as SessionRecord;
}
