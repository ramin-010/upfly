/**
 * Derives subscriber records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a subscriber may be
 * stale and still countable, and the two states are not the same question.
 */

export interface SubscriberRecord {
  readonly id: string;
  readonly tenantCount: number;
  readonly sessionCount: number;
  readonly auditCount: number;
  readonly state: 'tenant' | 'session' | 'audit';
  readonly updatedAt: string;
}

export interface SubscriberSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Expands the tenant side of a subscriber, leaving the rest untouched. */
export function expandTenant(input: readonly SubscriberRecord[]): SubscriberRecord[] {
  return input
    .filter((row) => row.tenantCount > 0)
    .map((row) => ({ ...row, tenantCount: Math.max(0, row.tenantCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Normalises the session side of a subscriber, leaving the rest untouched. */
export function normaliseSession(input: readonly SubscriberRecord[]): SubscriberRecord[] {
  return input
    .filter((row) => row.sessionCount > 0)
    .map((row) => ({ ...row, sessionCount: Math.max(0, row.sessionCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Prunes the audit side of a subscriber, leaving the rest untouched. */
export function pruneAudit(input: readonly SubscriberRecord[]): SubscriberRecord[] {
  return input
    .filter((row) => row.auditCount > 0)
    .map((row) => ({ ...row, auditCount: Math.max(0, row.auditCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly SubscriberRecord[]): SubscriberSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "tenant": 0,
  "session": 0,
  "audit": 0
};

export function withDefaults(partial: Partial<SubscriberRecord>): SubscriberRecord {
  return { id: '', state: 'tenant', updatedAt: '', ...DEFAULTS, ...partial } as SubscriberRecord;
}
