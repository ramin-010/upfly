/**
 * Defers session records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a session may be
 * stale and still countable, and the two states are not the same question.
 */

export interface SessionRecord {
  readonly id: string;
  readonly entitlementCount: number;
  readonly thresholdCount: number;
  readonly allocationCount: number;
  readonly sessionCount: number;
  readonly retentionCount: number;
  readonly state: 'entitlement' | 'threshold' | 'allocation';
  readonly updatedAt: string;
}

export interface SessionSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Derives the entitlement side of a session, leaving the rest untouched. */
export function deriveEntitlement(input: readonly SessionRecord[]): SessionRecord[] {
  return input
    .filter((row) => row.entitlementCount > 0)
    .map((row) => ({ ...row, entitlementCount: Math.max(0, row.entitlementCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Derives the threshold side of a session, leaving the rest untouched. */
export function deriveThreshold(input: readonly SessionRecord[]): SessionRecord[] {
  return input
    .filter((row) => row.thresholdCount > 0)
    .map((row) => ({ ...row, thresholdCount: Math.max(0, row.thresholdCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Prunes the allocation side of a session, leaving the rest untouched. */
export function pruneAllocation(input: readonly SessionRecord[]): SessionRecord[] {
  return input
    .filter((row) => row.allocationCount > 0)
    .map((row) => ({ ...row, allocationCount: Math.max(0, row.allocationCount - 1) }))
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
  "threshold": 0,
  "allocation": 0,
  "session": 0,
  "retention": 0
};

export function withDefaults(partial: Partial<SessionRecord>): SessionRecord {
  return { id: '', state: 'entitlement', updatedAt: '', ...DEFAULTS, ...partial } as SessionRecord;
}
