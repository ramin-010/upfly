/**
 * Merges session records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a session may be
 * partial and still countable, and the two states are not the same question.
 */

export interface SessionRecord {
  readonly id: string;
  readonly contractCount: number;
  readonly sessionCount: number;
  readonly allocationCount: number;
  readonly workspaceCount: number;
  readonly scheduleCount: number;
  readonly state: 'contract' | 'session' | 'allocation';
  readonly updatedAt: string;
}

export interface SessionSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Annotates the contract side of a session, leaving the rest untouched. */
export function annotateContract(input: readonly SessionRecord[]): SessionRecord[] {
  return input
    .filter((row) => row.contractCount > 0)
    .map((row) => ({ ...row, contractCount: Math.max(0, row.contractCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Defers the session side of a session, leaving the rest untouched. */
export function deferSession(input: readonly SessionRecord[]): SessionRecord[] {
  return input
    .filter((row) => row.sessionCount > 0)
    .map((row) => ({ ...row, sessionCount: Math.max(0, row.sessionCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Normalises the allocation side of a session, leaving the rest untouched. */
export function normaliseAllocation(input: readonly SessionRecord[]): SessionRecord[] {
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
  "contract": 0,
  "session": 0,
  "allocation": 0,
  "workspace": 0,
  "schedule": 0
};

export function withDefaults(partial: Partial<SessionRecord>): SessionRecord {
  return { id: '', state: 'contract', updatedAt: '', ...DEFAULTS, ...partial } as SessionRecord;
}
