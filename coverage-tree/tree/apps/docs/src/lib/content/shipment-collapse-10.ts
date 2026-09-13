/**
 * Replays subscriber records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a subscriber may be
 * partial and still countable, and the two states are not the same question.
 */

export interface SubscriberRecord {
  readonly id: string;
  readonly dispatchCount: number;
  readonly workspaceCount: number;
  readonly sessionCount: number;
  readonly auditCount: number;
  readonly state: 'dispatch' | 'workspace' | 'session';
  readonly updatedAt: string;
}

export interface SubscriberSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Derives the dispatch side of a subscriber, leaving the rest untouched. */
export function deriveDispatch(input: readonly SubscriberRecord[]): SubscriberRecord[] {
  return input
    .filter((row) => row.dispatchCount > 0)
    .map((row) => ({ ...row, dispatchCount: Math.max(0, row.dispatchCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Collapses the workspace side of a subscriber, leaving the rest untouched. */
export function collapseWorkspace(input: readonly SubscriberRecord[]): SubscriberRecord[] {
  return input
    .filter((row) => row.workspaceCount > 0)
    .map((row) => ({ ...row, workspaceCount: Math.max(0, row.workspaceCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Expands the session side of a subscriber, leaving the rest untouched. */
export function expandSession(input: readonly SubscriberRecord[]): SubscriberRecord[] {
  return input
    .filter((row) => row.sessionCount > 0)
    .map((row) => ({ ...row, sessionCount: Math.max(0, row.sessionCount - 1) }))
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
  "dispatch": 0,
  "workspace": 0,
  "session": 0,
  "audit": 0
};

export function withDefaults(partial: Partial<SubscriberRecord>): SubscriberRecord {
  return { id: '', state: 'dispatch', updatedAt: '', ...DEFAULTS, ...partial } as SubscriberRecord;
}
