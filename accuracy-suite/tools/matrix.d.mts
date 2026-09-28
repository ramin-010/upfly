/**
 * Types for `matrix.mjs`, so the tests that import it typecheck without casts. A
 * `@ts-expect-error` on the import would stop applying whenever the formatter wraps the
 * import differently; a declaration does not depend on line wrapping.
 *
 * `matrix.mjs` stays plain JavaScript outside `packages/core/src` because it measures the
 * engine and must not ship with it.
 */

/** One shape's row. There is no total row. */
export interface MatrixRow {
  readonly shape: string;
  readonly expected: number;
  readonly met: number;
  readonly missed: number;
  /** Entries in a file the scanner could not read, never counted as refusals. */
  readonly threw: number;
  readonly knownGap: number;
  /** A `knownGap` whose entry now agrees: the debt was settled and the record was not. */
  readonly staleGap: number;
  /**
   * A `knownGap` naming a mechanism this run did not exercise. Never `staleGap`, whatever
   * the engine said: agreement reached without the mechanism is an artefact of the
   * configuration, and reading it as closure would retire a live gap.
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

/** The vocabulary a key entry's `gapMechanism` may name. */
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
  /** The tree author's claim about what a correct engine does, printed beside the engine's. */
  readonly keyWhy: string;
  readonly keyGap: string;
  /** Which mechanism this entry's gap names, when it names one. */
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
 * An entry whose gap names a mechanism the run's configuration does not use, and the
 * bucket its outcome under that configuration put it in. Never a retired gap.
 */
export interface JudgedOnOutcome {
  readonly file: string;
  readonly line: number;
  readonly raw: string;
  readonly gapMechanism: string;
  readonly bucket: Bucket['key'];
}

/**
 * Every key entry and the bucket it landed in. The findings list cannot name every miss:
 * an entry in `knownGap` is unmet and produces no finding.
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

/** What the engine produced for one keyed file, each reference at a UTF-16 code-unit offset. */
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

/** Finding kinds reported for visibility and never counted against the run. */
export const NON_DEFECT_KINDS: readonly string[];

/** Byte offset to UTF-16 code-unit offset: the key counts bytes, the engine code units. */
export function toCodeUnits(bytes: Uint8Array, byteOffset: number): number;

export function buildMatrix(
  key: unknown,
  observed: ReadonlyMap<string, Observation>,
  options?: {
    readonly declarationOf?: (id: string) => { adapterEmitsAs?: readonly string[] } | undefined;
    /**
     * The `GAP_MECHANISMS` this run exercises. A `knownGap` naming anything outside it and
     * outside `outOfConfiguration` lands in `notExercised` and cannot be retired by this run.
     * Defaults to empty, so a gap stays open until a run states that it used the mechanism.
     */
    readonly exercises?: ReadonlySet<string>;
    /**
     * A separate run per exercised mechanism, which an entry naming that mechanism is
     * judged on instead of `observed`. Supplying one for a mechanism not in `exercises`
     * throws.
     */
    readonly observedUnder?: Readonly<Record<string, ReadonlyMap<string, Observation>>>;
    /**
     * Mechanisms this run's configuration does not use, as detection is unused when the key
     * states its serving roots. An entry whose gap names one is judged `met` or `missed` on
     * its outcome, and its gap is never retired. Naming a mechanism here and in `exercises`
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
 * Everything but the per-shape table: arithmetic, populations, notes, findings and unkeyed
 * emissions. For a second run over the same key, where the misses are the answer.
 */
export function renderSummary(
  result: MatrixResult,
  options?: { readonly emissionOf?: (id: string) => string | undefined },
): string;

/**
 * The `claimed` population's `met` of `expected`, from the tally the table prints, and
 * every claimed entry it did not meet, so each can be named in a published result.
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

/** What the instrument cannot tell you, as text any rendering can print. */
export function blindSpots(): readonly string[];
