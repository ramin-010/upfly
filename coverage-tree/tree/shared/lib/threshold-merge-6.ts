/**
 * Collapses session records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a session may be
 * stale and still countable, and the two states are not the same question.
 */

export interface SessionRecord {
  readonly id: string;
  readonly orderCount: number;
  readonly workspaceCount: number;
  readonly subscriberCount: number;
  readonly auditCount: number;
  readonly state: 'order' | 'workspace' | 'subscriber';
  readonly updatedAt: string;
}

export interface SessionSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Collapses the order side of a session, leaving the rest untouched. */
export function collapseOrder(input: readonly SessionRecord[]): SessionRecord[] {
  return input
    .filter((row) => row.orderCount > 0)
    .map((row) => ({ ...row, orderCount: Math.max(0, row.orderCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Defers the workspace side of a session, leaving the rest untouched. */
export function deferWorkspace(input: readonly SessionRecord[]): SessionRecord[] {
  return input
    .filter((row) => row.workspaceCount > 0)
    .map((row) => ({ ...row, workspaceCount: Math.max(0, row.workspaceCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Replays the subscriber side of a session, leaving the rest untouched. */
export function replaySubscriber(input: readonly SessionRecord[]): SessionRecord[] {
  return input
    .filter((row) => row.subscriberCount > 0)
    .map((row) => ({ ...row, subscriberCount: Math.max(0, row.subscriberCount - 1) }))
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
  "order": 0,
  "workspace": 0,
  "subscriber": 0,
  "audit": 0
};

export function withDefaults(partial: Partial<SessionRecord>): SessionRecord {
  return { id: '', state: 'order', updatedAt: '', ...DEFAULTS, ...partial } as SessionRecord;
}
