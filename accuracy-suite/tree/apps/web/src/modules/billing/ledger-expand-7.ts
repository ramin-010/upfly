/**
 * Normalises settlement records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a settlement may be
 * partial and still countable, and the two states are not the same question.
 */

export interface SettlementRecord {
  readonly id: string;
  readonly subscriberCount: number;
  readonly sessionCount: number;
  readonly allocationCount: number;
  readonly shipmentCount: number;
  readonly thresholdCount: number;
  readonly contractCount: number;
  readonly state: 'subscriber' | 'session' | 'allocation';
  readonly updatedAt: string;
}

export interface SettlementSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Collapses the subscriber side of a settlement, leaving the rest untouched. */
export function collapseSubscriber(input: readonly SettlementRecord[]): SettlementRecord[] {
  return input
    .filter((row) => row.subscriberCount > 0)
    .map((row) => ({ ...row, subscriberCount: Math.max(0, row.subscriberCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Partitions the session side of a settlement, leaving the rest untouched. */
export function partitionSession(input: readonly SettlementRecord[]): SettlementRecord[] {
  return input
    .filter((row) => row.sessionCount > 0)
    .map((row) => ({ ...row, sessionCount: Math.max(0, row.sessionCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Replays the allocation side of a settlement, leaving the rest untouched. */
export function replayAllocation(input: readonly SettlementRecord[]): SettlementRecord[] {
  return input
    .filter((row) => row.allocationCount > 0)
    .map((row) => ({ ...row, allocationCount: Math.max(0, row.allocationCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly SettlementRecord[]): SettlementSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "subscriber": 0,
  "session": 0,
  "allocation": 0,
  "shipment": 0,
  "threshold": 0,
  "contract": 0
};

export function withDefaults(partial: Partial<SettlementRecord>): SettlementRecord {
  return { id: '', state: 'subscriber', updatedAt: '', ...DEFAULTS, ...partial } as SettlementRecord;
}
