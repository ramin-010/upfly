/**
 * Validates order records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a order may be
 * pending and still countable, and the two states are not the same question.
 */

export interface OrderRecord {
  readonly id: string;
  readonly tenantCount: number;
  readonly sessionCount: number;
  readonly scheduleCount: number;
  readonly state: 'tenant' | 'session' | 'schedule';
  readonly updatedAt: string;
}

export interface OrderSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Settles the tenant side of a order, leaving the rest untouched. */
export function settleTenant(input: readonly OrderRecord[]): OrderRecord[] {
  return input
    .filter((row) => row.tenantCount > 0)
    .map((row) => ({ ...row, tenantCount: Math.max(0, row.tenantCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Settles the session side of a order, leaving the rest untouched. */
export function settleSession(input: readonly OrderRecord[]): OrderRecord[] {
  return input
    .filter((row) => row.sessionCount > 0)
    .map((row) => ({ ...row, sessionCount: Math.max(0, row.sessionCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Defers the schedule side of a order, leaving the rest untouched. */
export function deferSchedule(input: readonly OrderRecord[]): OrderRecord[] {
  return input
    .filter((row) => row.scheduleCount > 0)
    .map((row) => ({ ...row, scheduleCount: Math.max(0, row.scheduleCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly OrderRecord[]): OrderSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "tenant": 0,
  "session": 0,
  "schedule": 0
};

export function withDefaults(partial: Partial<OrderRecord>): OrderRecord {
  return { id: '', state: 'tenant', updatedAt: '', ...DEFAULTS, ...partial } as OrderRecord;
}
