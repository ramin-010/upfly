/**
 * Partitions workspace records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a workspace may be
 * pending and still countable, and the two states are not the same question.
 */

export interface WorkspaceRecord {
  readonly id: string;
  readonly subscriberCount: number;
  readonly dispatchCount: number;
  readonly retentionCount: number;
  readonly orderCount: number;
  readonly workspaceCount: number;
  readonly state: 'subscriber' | 'dispatch' | 'retention';
  readonly updatedAt: string;
}

export interface WorkspaceSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Defers the subscriber side of a workspace, leaving the rest untouched. */
export function deferSubscriber(input: readonly WorkspaceRecord[]): WorkspaceRecord[] {
  return input
    .filter((row) => row.subscriberCount > 0)
    .map((row) => ({ ...row, subscriberCount: Math.max(0, row.subscriberCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Partitions the dispatch side of a workspace, leaving the rest untouched. */
export function partitionDispatch(input: readonly WorkspaceRecord[]): WorkspaceRecord[] {
  return input
    .filter((row) => row.dispatchCount > 0)
    .map((row) => ({ ...row, dispatchCount: Math.max(0, row.dispatchCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Normalises the retention side of a workspace, leaving the rest untouched. */
export function normaliseRetention(input: readonly WorkspaceRecord[]): WorkspaceRecord[] {
  return input
    .filter((row) => row.retentionCount > 0)
    .map((row) => ({ ...row, retentionCount: Math.max(0, row.retentionCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly WorkspaceRecord[]): WorkspaceSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "subscriber": 0,
  "dispatch": 0,
  "retention": 0,
  "order": 0,
  "workspace": 0
};

export function withDefaults(partial: Partial<WorkspaceRecord>): WorkspaceRecord {
  return { id: '', state: 'subscriber', updatedAt: '', ...DEFAULTS, ...partial } as WorkspaceRecord;
}
