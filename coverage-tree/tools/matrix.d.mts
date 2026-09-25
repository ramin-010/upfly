/**
 * Types for `matrix.mjs`, so the harness's proofs typecheck instead of being cast.
 *
 * ⚠️ **This exists because a `@ts-expect-error` on the import did not survive the
 * formatter.** Biome reflowed the import across four lines, the directive stopped
 * applying to the line that errors, and the suppression then failed as *unused* while the
 * real error came back — a suppression whose correctness depends on line wrapping. Rule 1
 * forbids `any` in an API and rule 17's test typechecking is what caught a bad fixture
 * once already; a declaration is the answer that does not rot.
 *
 * 🔴 **`matrix.mjs` stays plain JavaScript deliberately.** It is measuring instrument, not
 * shipped code: it must not live inside `packages/core/src`, where it would be published
 * with the engine and counted by the coverage gate. A `.d.mts` beside it is the seam.
 */

/** One shape's row. There is deliberately no total (R75). */
export interface MatrixRow {
  readonly shape: string;
  readonly expected: number;
  readonly met: number;
  readonly missed: number;
  /** A file the scanner could not read (R86). Named, never merged into a refusal. */
  readonly threw: number;
  readonly knownGap: number;
  /** A `knownGap` whose entry now agrees: the debt was settled and the record was not. */
  readonly staleGap: number;
  /**
   * R96: a `knownGap` naming a mechanism this run did not exercise. **Never `staleGap`,
   * whatever the engine said** — agreement reached with the mechanism switched off is an
   * artefact of the configuration, and reading it as closure retires a live defect.
   */
  readonly notExercised: number;
}

/** One bucket an entry can land in. The table's columns are derived from this list. */
export interface Bucket {
  readonly key: 'met' | 'missed' | 'threw' | 'knownGap' | 'staleGap' | 'notExercised';
  readonly label: string;
  /** Whether an entry in this bucket produces a finding. `reconcile` cross-checks it. */
  readonly emitsFinding: boolean;
}

export declare const BUCKETS: readonly Bucket[];

/** The vocabulary a key entry's `gapMechanism` may name (R96). */
export declare const GAP_MECHANISMS: readonly string[];

export interface MatrixFinding {
  readonly file: string;
  readonly line: number;
  readonly raw: string;
  readonly shape: string;
  readonly kind:
    | 'wrong-outcome'
    | 'threw'
    | 'threw-expected-silence'
    | 'stale-known-gap'
    | 'gap-not-exercised'
    | 'not-observed';
  readonly detail: string;
  /** The tree author's claim about what a correct engine does. R90: both sides speak. */
  readonly keyWhy: string;
  readonly keyGap: string;
  /** Which mechanism this entry's gap names, when it names one (R96). */
  readonly gapMechanism: string;
  /** The engine's own words about its decision. */
  readonly engineNote: string;
}

export interface ShapeDisagreement {
  readonly file: string;
  readonly line: number;
  readonly keyShape: string;
  readonly engineShape: string;
  /** True when the key shape declares an `adapterEmitsAs` naming what the engine emitted. */
  readonly explained: boolean;
}

export interface UnkeyedEmission {
  readonly file: string;
  readonly start: number;
  readonly shape: string;
  readonly resolution: string;
  readonly rawPath: string;
}

/** Whether the matrix's own buckets add up. A table that does not add up still prints. */
export interface Arithmetic {
  readonly closes: boolean;
  readonly problems: readonly string[];
  readonly entries: number;
}

/**
 * R179: an entry whose gap names a mechanism the run's configuration does not use, and
 * the bucket its outcome under that configuration put it in. Never a retired gap.
 */
export interface JudgedOnOutcome {
  readonly file: string;
  readonly line: number;
  readonly raw: string;
  readonly gapMechanism: string;
  readonly bucket: Bucket['key'];
}

/**
 * R179: every key entry and the bucket it landed in. The findings list cannot name every
 * miss — an entry in `knownGap` is unmet and deliberately produces no finding.
 */
export interface Verdict {
  readonly file: string;
  readonly line: number;
  readonly raw: string;
  readonly shape: string;
  readonly bucket: Bucket['key'];
  readonly detail: string;
  readonly keyGap: string;
}

export interface MatrixResult {
  readonly rows: readonly MatrixRow[];
  readonly findings: readonly MatrixFinding[];
  readonly unkeyed: readonly UnkeyedEmission[];
  readonly shapeDisagreements: readonly ShapeDisagreement[];
  readonly arithmetic: Arithmetic;
  readonly outOfConfiguration: readonly JudgedOnOutcome[];
  readonly verdicts: readonly Verdict[];
}

/** One reference as the engine produced it, at a UTF-16 code-unit offset. */
export interface Observation {
  readonly path: string;
  /** Why the scanner could not read the file, or `null`. */
  readonly threw: string | null;
  readonly references: readonly {
    readonly start: number;
    readonly shape: string;
    readonly resolution: string;
    readonly rawPath: string;
    readonly note?: string;
  }[];
}

/** Which engine outcomes satisfy one `expect` value. `absent` means nothing was emitted. */
export const ACCEPTS: Readonly<Record<string, readonly string[]>>;

/** Outcomes that must never satisfy an expect that also accepts silence. */
export const NEVER_ACCEPTABLE_AS_SILENCE: readonly string[];

/** Finding kinds reported for visibility and never counted against the run (R90). */
export const NON_DEFECT_KINDS: readonly string[];

/** Byte offset to UTF-16 code-unit offset (R84). */
export function toCodeUnits(bytes: Uint8Array, byteOffset: number): number;

export function buildMatrix(
  key: unknown,
  observed: ReadonlyMap<string, Observation>,
  options?: {
    readonly declarationOf?: (id: string) => { adapterEmitsAs?: readonly string[] } | undefined;
    /**
     * R96: the `GAP_MECHANISMS` this run actually exercises. A `knownGap` naming anything
     * outside it lands in `notExercised` and can never be retired by this run. Defaults to
     * EMPTY — the safe direction, because the alternative deletes a debt nobody tested.
     */
    readonly exercises?: ReadonlySet<string>;
    /**
     * A separate run per exercised mechanism, which an entry naming that mechanism is
     * judged on instead of `observed`. Supplying one for a mechanism not in `exercises`
     * throws.
     */
    readonly observedUnder?: Readonly<Record<string, ReadonlyMap<string, Observation>>>;
    /**
     * R179: mechanisms this run's CONFIGURATION does not use — detection, when the key
     * states its serving roots. An entry whose gap names one is judged `met` or `missed` on
     * its outcome and its gap is never retired. Naming a mechanism here AND in `exercises`
     * throws.
     */
    readonly outOfConfiguration?: ReadonlySet<string>;
  },
): MatrixResult;

export function renderMatrix(
  result: MatrixResult,
  options?: { readonly emissionOf?: (id: string) => string | undefined },
): string;

/**
 * R179: everything but the per-shape table — arithmetic, populations, notes, findings,
 * unkeyed emissions. For a second run over the same key, where the misses are the answer.
 */
export function renderSummary(
  result: MatrixResult,
  options?: { readonly emissionOf?: (id: string) => string | undefined },
): string;

/**
 * The `claimed` population's `met` of `expected`, from the tally the table prints, and
 * every claimed entry it did not meet — each a named line in a published result (R179).
 */
export function claimedPopulation(
  result: MatrixResult,
  options?: { readonly emissionOf?: (id: string) => string | undefined },
): { readonly met: number; readonly expected: number; readonly misses: readonly Verdict[] };

/** Does every key entry land in exactly one bucket? Exported so its proofs can damage it. */
export function reconcile(
  rows: readonly MatrixRow[],
  key: { readonly files: readonly { readonly entries: readonly unknown[] }[] },
  findings: readonly unknown[],
): Arithmetic;

/** What the instrument cannot tell you, as prose a rendering cannot omit. */
export function blindSpots(): readonly string[];
