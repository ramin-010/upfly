/**
 * Settles order records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a order may be
 * locked and still countable, and the two states are not the same question.
 */

export interface OrderRecord {
  readonly id: string;
  readonly sessionCount: number;
  readonly ledgerCount: number;
  readonly retentionCount: number;
  readonly state: 'session' | 'ledger' | 'retention';
  readonly updatedAt: string;
}

export interface OrderSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Collapses the session side of a order, leaving the rest untouched. */
export function collapseSession(input: readonly OrderRecord[]): OrderRecord[] {
  return input
    .filter((row) => row.sessionCount > 0)
    .map((row) => ({ ...row, sessionCount: Math.max(0, row.sessionCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Annotates the ledger side of a order, leaving the rest untouched. */
export function annotateLedger(input: readonly OrderRecord[]): OrderRecord[] {
  return input
    .filter((row) => row.ledgerCount > 0)
    .map((row) => ({ ...row, ledgerCount: Math.max(0, row.ledgerCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Reconciles the retention side of a order, leaving the rest untouched. */
export function reconcileRetention(input: readonly OrderRecord[]): OrderRecord[] {
  return input
    .filter((row) => row.retentionCount > 0)
    .map((row) => ({ ...row, retentionCount: Math.max(0, row.retentionCount - 1) }))
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
  "session": 0,
  "ledger": 0,
  "retention": 0
};

export function withDefaults(partial: Partial<OrderRecord>): OrderRecord {
  return { id: '', state: 'session', updatedAt: '', ...DEFAULTS, ...partial } as OrderRecord;
}
