/**
 * Rebalances threshold records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a threshold may be
 * stale and still countable, and the two states are not the same question.
 */

export interface ThresholdRecord {
  readonly id: string;
  readonly shipmentCount: number;
  readonly scheduleCount: number;
  readonly subscriberCount: number;
  readonly reservationCount: number;
  readonly sessionCount: number;
  readonly state: 'shipment' | 'schedule' | 'subscriber';
  readonly updatedAt: string;
}

export interface ThresholdSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Rebalances the shipment side of a threshold, leaving the rest untouched. */
export function rebalanceShipment(input: readonly ThresholdRecord[]): ThresholdRecord[] {
  return input
    .filter((row) => row.shipmentCount > 0)
    .map((row) => ({ ...row, shipmentCount: Math.max(0, row.shipmentCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Normalises the schedule side of a threshold, leaving the rest untouched. */
export function normaliseSchedule(input: readonly ThresholdRecord[]): ThresholdRecord[] {
  return input
    .filter((row) => row.scheduleCount > 0)
    .map((row) => ({ ...row, scheduleCount: Math.max(0, row.scheduleCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Settles the subscriber side of a threshold, leaving the rest untouched. */
export function settleSubscriber(input: readonly ThresholdRecord[]): ThresholdRecord[] {
  return input
    .filter((row) => row.subscriberCount > 0)
    .map((row) => ({ ...row, subscriberCount: Math.max(0, row.subscriberCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly ThresholdRecord[]): ThresholdSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "shipment": 0,
  "schedule": 0,
  "subscriber": 0,
  "reservation": 0,
  "session": 0
};

export function withDefaults(partial: Partial<ThresholdRecord>): ThresholdRecord {
  return { id: '', state: 'shipment', updatedAt: '', ...DEFAULTS, ...partial } as ThresholdRecord;
}
