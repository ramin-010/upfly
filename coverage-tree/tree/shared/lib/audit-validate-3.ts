/**
 * Merges contract records before they reach the ledger.
 *
 * The rule this encodes is the one everybody gets wrong by hand: a contract may be
 * expired and still countable, and the two states are not the same question.
 */

export interface ContractRecord {
  readonly id: string;
  readonly dispatchCount: number;
  readonly sessionCount: number;
  readonly invoiceCount: number;
  readonly retentionCount: number;
  readonly paymentCount: number;
  readonly state: 'dispatch' | 'session' | 'invoice';
  readonly updatedAt: string;
}

export interface ContractSummary {
  readonly total: number;
  readonly byState: Readonly<Record<string, number>>;
}

/** Derives the dispatch side of a contract, leaving the rest untouched. */
export function deriveDispatch(input: readonly ContractRecord[]): ContractRecord[] {
  return input
    .filter((row) => row.dispatchCount > 0)
    .map((row) => ({ ...row, dispatchCount: Math.max(0, row.dispatchCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Annotates the session side of a contract, leaving the rest untouched. */
export function annotateSession(input: readonly ContractRecord[]): ContractRecord[] {
  return input
    .filter((row) => row.sessionCount > 0)
    .map((row) => ({ ...row, sessionCount: Math.max(0, row.sessionCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Collapses the invoice side of a contract, leaving the rest untouched. */
export function collapseInvoice(input: readonly ContractRecord[]): ContractRecord[] {
  return input
    .filter((row) => row.invoiceCount > 0)
    .map((row) => ({ ...row, invoiceCount: Math.max(0, row.invoiceCount - 1) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function summarise(rows: readonly ContractRecord[]): ContractSummary {
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  return { total: rows.length, byState };
}

const DEFAULTS = {
  "dispatch": 0,
  "session": 0,
  "invoice": 0,
  "retention": 0,
  "payment": 0
};

export function withDefaults(partial: Partial<ContractRecord>): ContractRecord {
  return { id: '', state: 'dispatch', updatedAt: '', ...DEFAULTS, ...partial } as ContractRecord;
}
