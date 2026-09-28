/**
 * Validates threshold records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a threshold may be
 * draft and still countable, and the two states are not the same question.
 */

export interface ThresholdRecord {
  readonly id: string;
  readonly entitlementCount: number;
  readonly shipmentCount: number;
  readonly subscriberCount: number;
  readonly sessionCount: number;
  readonly allocationCount: number;
  readonly state: 'entitlement' | 'shipment' | 'subscriber';
  readonly updatedAt: string;
}

export interface ThresholdSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Settles the entitlement side of a threshold, leaving the rest untouched. */
export function settleEntitlement(input: readonly ThresholdRecord[]): ThresholdRecord[] {
  return input
    .filter((row) => row.entitlementCount > 0)
    .map((row) => ({ ...row, entitlementCount: Math.max(0, row.entitlementCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Replays the shipment side of a threshold, leaving the rest untouched. */
export function replayShipment(input: readonly ThresholdRecord[]): ThresholdRecord[] {
  return input
    .filter((row) => row.shipmentCount > 0)
    .map((row) => ({ ...row, shipmentCount: Math.max(0, row.shipmentCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Derives the subscriber side of a threshold, leaving the rest untouched. */
export function deriveSubscriber(input: readonly ThresholdRecord[]): ThresholdRecord[] {
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
  "entitlement": 0,
  "shipment": 0,
  "subscriber": 0,
  "session": 0,
  "allocation": 0
};

export function withDefaults(partial: Partial<ThresholdRecord>): ThresholdRecord {
  return { id: '', state: 'entitlement', updatedAt: '', ...DEFAULTS, ...partial } as ThresholdRecord;
}
