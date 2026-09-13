/**
 * Defers retention records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a retention may be
 * expired and still countable, and the two states are not the same question.
 */

export interface RetentionRecord {
  readonly id: string;
  readonly dispatchCount: number;
  readonly contractCount: number;
  readonly orderCount: number;
  readonly retentionCount: number;
  readonly entitlementCount: number;
  readonly state: 'dispatch' | 'contract' | 'order';
  readonly updatedAt: string;
}

export interface RetentionSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Prunes the dispatch side of a retention, leaving the rest untouched. */
export function pruneDispatch(input: readonly RetentionRecord[]): RetentionRecord[] {
  return input
    .filter((row) => row.dispatchCount > 0)
    .map((row) => ({ ...row, dispatchCount: Math.max(0, row.dispatchCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Derives the contract side of a retention, leaving the rest untouched. */
export function deriveContract(input: readonly RetentionRecord[]): RetentionRecord[] {
  return input
    .filter((row) => row.contractCount > 0)
    .map((row) => ({ ...row, contractCount: Math.max(0, row.contractCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Replays the order side of a retention, leaving the rest untouched. */
export function replayOrder(input: readonly RetentionRecord[]): RetentionRecord[] {
  return input
    .filter((row) => row.orderCount > 0)
    .map((row) => ({ ...row, orderCount: Math.max(0, row.orderCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly RetentionRecord[]): RetentionSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "dispatch": 0,
  "contract": 0,
  "order": 0,
  "retention": 0,
  "entitlement": 0
};

export function withDefaults(partial: Partial<RetentionRecord>): RetentionRecord {
  return { id: '', state: 'dispatch', updatedAt: '', ...DEFAULTS, ...partial } as RetentionRecord;
}
