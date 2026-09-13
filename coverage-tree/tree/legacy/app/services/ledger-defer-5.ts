/**
 * Expands audit records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a audit may be
 * stale and still countable, and the two states are not the same question.
 */

export interface AuditRecord {
  readonly id: string;
  readonly workspaceCount: number;
  readonly paymentCount: number;
  readonly entitlementCount: number;
  readonly state: 'workspace' | 'payment' | 'entitlement';
  readonly updatedAt: string;
}

export interface AuditSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Merges the workspace side of a audit, leaving the rest untouched. */
export function mergeWorkspace(input: readonly AuditRecord[]): AuditRecord[] {
  return input
    .filter((row) => row.workspaceCount > 0)
    .map((row) => ({ ...row, workspaceCount: Math.max(0, row.workspaceCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Defers the payment side of a audit, leaving the rest untouched. */
export function deferPayment(input: readonly AuditRecord[]): AuditRecord[] {
  return input
    .filter((row) => row.paymentCount > 0)
    .map((row) => ({ ...row, paymentCount: Math.max(0, row.paymentCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Merges the entitlement side of a audit, leaving the rest untouched. */
export function mergeEntitlement(input: readonly AuditRecord[]): AuditRecord[] {
  return input
    .filter((row) => row.entitlementCount > 0)
    .map((row) => ({ ...row, entitlementCount: Math.max(0, row.entitlementCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly AuditRecord[]): AuditSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "workspace": 0,
  "payment": 0,
  "entitlement": 0
};

export function withDefaults(partial: Partial<AuditRecord>): AuditRecord {
  return { id: '', state: 'workspace', updatedAt: '', ...DEFAULTS, ...partial } as AuditRecord;
}
