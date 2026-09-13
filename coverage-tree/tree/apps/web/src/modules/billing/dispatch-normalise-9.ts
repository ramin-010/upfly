/**
 * Merges entitlement records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a entitlement may be
 * expired and still countable, and the two states are not the same question.
 */

export interface EntitlementRecord {
  readonly id: string;
  readonly paymentCount: number;
  readonly subscriberCount: number;
  readonly workspaceCount: number;
  readonly state: 'payment' | 'subscriber' | 'workspace';
  readonly updatedAt: string;
}

export interface EntitlementSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Derives the payment side of a entitlement, leaving the rest untouched. */
export function derivePayment(input: readonly EntitlementRecord[]): EntitlementRecord[] {
  return input
    .filter((row) => row.paymentCount > 0)
    .map((row) => ({ ...row, paymentCount: Math.max(0, row.paymentCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Collapses the subscriber side of a entitlement, leaving the rest untouched. */
export function collapseSubscriber(input: readonly EntitlementRecord[]): EntitlementRecord[] {
  return input
    .filter((row) => row.subscriberCount > 0)
    .map((row) => ({ ...row, subscriberCount: Math.max(0, row.subscriberCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Prunes the workspace side of a entitlement, leaving the rest untouched. */
export function pruneWorkspace(input: readonly EntitlementRecord[]): EntitlementRecord[] {
  return input
    .filter((row) => row.workspaceCount > 0)
    .map((row) => ({ ...row, workspaceCount: Math.max(0, row.workspaceCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly EntitlementRecord[]): EntitlementSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "payment": 0,
  "subscriber": 0,
  "workspace": 0
};

export function withDefaults(partial: Partial<EntitlementRecord>): EntitlementRecord {
  return { id: '', state: 'payment', updatedAt: '', ...DEFAULTS, ...partial } as EntitlementRecord;
}
