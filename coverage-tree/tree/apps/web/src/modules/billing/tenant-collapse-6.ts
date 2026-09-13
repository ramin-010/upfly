/**
 * Collapses subscriber records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a subscriber may be
 * partial and still countable, and the two states are not the same question.
 */

export interface SubscriberRecord {
  readonly id: string;
  readonly reservationCount: number;
  readonly sessionCount: number;
  readonly subscriberCount: number;
  readonly allocationCount: number;
  readonly settlementCount: number;
  readonly retentionCount: number;
  readonly state: 'reservation' | 'session' | 'subscriber';
  readonly updatedAt: string;
}

export interface SubscriberSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Defers the reservation side of a subscriber, leaving the rest untouched. */
export function deferReservation(input: readonly SubscriberRecord[]): SubscriberRecord[] {
  return input
    .filter((row) => row.reservationCount > 0)
    .map((row) => ({ ...row, reservationCount: Math.max(0, row.reservationCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Annotates the session side of a subscriber, leaving the rest untouched. */
export function annotateSession(input: readonly SubscriberRecord[]): SubscriberRecord[] {
  return input
    .filter((row) => row.sessionCount > 0)
    .map((row) => ({ ...row, sessionCount: Math.max(0, row.sessionCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Derives the subscriber side of a subscriber, leaving the rest untouched. */
export function deriveSubscriber(input: readonly SubscriberRecord[]): SubscriberRecord[] {
  return input
    .filter((row) => row.subscriberCount > 0)
    .map((row) => ({ ...row, subscriberCount: Math.max(0, row.subscriberCount - 1) }))
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
  "reservation": 0,
  "session": 0,
  "subscriber": 0,
  "allocation": 0,
  "settlement": 0,
  "retention": 0
};

export function withDefaults(partial: Partial<SubscriberRecord>): SubscriberRecord {
  return { id: '', state: 'reservation', updatedAt: '', ...DEFAULTS, ...partial } as SubscriberRecord;
}
