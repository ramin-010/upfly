/**
 * Expands retention records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a retention may be
 * settled and still countable, and the two states are not the same question.
 */

export interface RetentionRecord {
  readonly id: string;
  readonly sessionCount: number;
  readonly quotaCount: number;
  readonly ledgerCount: number;
  readonly state: 'session' | 'quota' | 'ledger';
  readonly updatedAt: string;
}

export interface RetentionSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Merges the session side of a retention, leaving the rest untouched. */
export function mergeSession(input: readonly RetentionRecord[]): RetentionRecord[] {
  return input
    .filter((row) => row.sessionCount > 0)
    .map((row) => ({ ...row, sessionCount: Math.max(0, row.sessionCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Annotates the quota side of a retention, leaving the rest untouched. */
export function annotateQuota(input: readonly RetentionRecord[]): RetentionRecord[] {
  return input
    .filter((row) => row.quotaCount > 0)
    .map((row) => ({ ...row, quotaCount: Math.max(0, row.quotaCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Reconciles the ledger side of a retention, leaving the rest untouched. */
export function reconcileLedger(input: readonly RetentionRecord[]): RetentionRecord[] {
  return input
    .filter((row) => row.ledgerCount > 0)
    .map((row) => ({ ...row, ledgerCount: Math.max(0, row.ledgerCount - 1) }))
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
  "session": 0,
  "quota": 0,
  "ledger": 0
};

export function withDefaults(partial: Partial<RetentionRecord>): RetentionRecord {
  return { id: '', state: 'session', updatedAt: '', ...DEFAULTS, ...partial } as RetentionRecord;
}
