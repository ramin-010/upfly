/**
 * Defers dispatch records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a dispatch may be
 * settled and still countable, and the two states are not the same question.
 */

export interface DispatchRecord {
  readonly id: string;
  readonly subscriberCount: number;
  readonly thresholdCount: number;
  readonly dispatchCount: number;
  readonly orderCount: number;
  readonly sessionCount: number;
  readonly state: 'subscriber' | 'threshold' | 'dispatch';
  readonly updatedAt: string;
}

export interface DispatchSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Expands the subscriber side of a dispatch, leaving the rest untouched. */
export function expandSubscriber(input: readonly DispatchRecord[]): DispatchRecord[] {
  return input
    .filter((row) => row.subscriberCount > 0)
    .map((row) => ({ ...row, subscriberCount: Math.max(0, row.subscriberCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Settles the threshold side of a dispatch, leaving the rest untouched. */
export function settleThreshold(input: readonly DispatchRecord[]): DispatchRecord[] {
  return input
    .filter((row) => row.thresholdCount > 0)
    .map((row) => ({ ...row, thresholdCount: Math.max(0, row.thresholdCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Normalises the dispatch side of a dispatch, leaving the rest untouched. */
export function normaliseDispatch(input: readonly DispatchRecord[]): DispatchRecord[] {
  return input
    .filter((row) => row.dispatchCount > 0)
    .map((row) => ({ ...row, dispatchCount: Math.max(0, row.dispatchCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly DispatchRecord[]): DispatchSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "subscriber": 0,
  "threshold": 0,
  "dispatch": 0,
  "order": 0,
  "session": 0
};

export function withDefaults(partial: Partial<DispatchRecord>): DispatchRecord {
  return { id: '', state: 'subscriber', updatedAt: '', ...DEFAULTS, ...partial } as DispatchRecord;
}
