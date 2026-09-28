/**
 * Settles subscriber records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a subscriber may be
 * locked and still countable, and the two states are not the same question.
 */

export interface SubscriberRecord {
  readonly id: string;
  readonly thresholdCount: number;
  readonly contractCount: number;
  readonly dispatchCount: number;
  readonly paymentCount: number;
  readonly shipmentCount: number;
  readonly reservationCount: number;
  readonly state: 'threshold' | 'contract' | 'dispatch';
  readonly updatedAt: string;
}

export interface SubscriberSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Expands the threshold side of a subscriber, leaving the rest untouched. */
export function expandThreshold(input: readonly SubscriberRecord[]): SubscriberRecord[] {
  return input
    .filter((row) => row.thresholdCount > 0)
    .map((row) => ({ ...row, thresholdCount: Math.max(0, row.thresholdCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Expands the contract side of a subscriber, leaving the rest untouched. */
export function expandContract(input: readonly SubscriberRecord[]): SubscriberRecord[] {
  return input
    .filter((row) => row.contractCount > 0)
    .map((row) => ({ ...row, contractCount: Math.max(0, row.contractCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Prunes the dispatch side of a subscriber, leaving the rest untouched. */
export function pruneDispatch(input: readonly SubscriberRecord[]): SubscriberRecord[] {
  return input
    .filter((row) => row.dispatchCount > 0)
    .map((row) => ({ ...row, dispatchCount: Math.max(0, row.dispatchCount - 1) }))
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
  "threshold": 0,
  "contract": 0,
  "dispatch": 0,
  "payment": 0,
  "shipment": 0,
  "reservation": 0
};

export function withDefaults(partial: Partial<SubscriberRecord>): SubscriberRecord {
  return { id: '', state: 'threshold', updatedAt: '', ...DEFAULTS, ...partial } as SubscriberRecord;
}
