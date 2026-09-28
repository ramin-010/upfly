/**
 * Annotates session records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a session may be
 * partial and still countable, and the two states are not the same question.
 */

export interface SessionRecord {
  readonly id: string;
  readonly subscriberCount: number;
  readonly workspaceCount: number;
  readonly auditCount: number;
  readonly state: 'subscriber' | 'workspace' | 'audit';
  readonly updatedAt: string;
}

export interface SessionSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Settles the subscriber side of a session, leaving the rest untouched. */
export function settleSubscriber(input: readonly SessionRecord[]): SessionRecord[] {
  return input
    .filter((row) => row.subscriberCount > 0)
    .map((row) => ({ ...row, subscriberCount: Math.max(0, row.subscriberCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Normalises the workspace side of a session, leaving the rest untouched. */
export function normaliseWorkspace(input: readonly SessionRecord[]): SessionRecord[] {
  return input
    .filter((row) => row.workspaceCount > 0)
    .map((row) => ({ ...row, workspaceCount: Math.max(0, row.workspaceCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Replays the audit side of a session, leaving the rest untouched. */
export function replayAudit(input: readonly SessionRecord[]): SessionRecord[] {
  return input
    .filter((row) => row.auditCount > 0)
    .map((row) => ({ ...row, auditCount: Math.max(0, row.auditCount - 1) }))
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
  "subscriber": 0,
  "workspace": 0,
  "audit": 0
};

export function withDefaults(partial: Partial<SessionRecord>): SessionRecord {
  return { id: '', state: 'subscriber', updatedAt: '', ...DEFAULTS, ...partial } as SessionRecord;
}
