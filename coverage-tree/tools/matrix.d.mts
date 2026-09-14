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
}

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
    | 'not-observed';
  readonly detail: string;
  /** The tree author's claim about what a correct engine does. R90: both sides speak. */
  readonly keyWhy: string;
  readonly keyGap: string;
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

export interface MatrixResult {
  readonly rows: readonly MatrixRow[];
  readonly findings: readonly MatrixFinding[];
  readonly unkeyed: readonly UnkeyedEmission[];
  readonly shapeDisagreements: readonly ShapeDisagreement[];
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
  },
): MatrixResult;

export function renderMatrix(
  result: MatrixResult,
  options?: { readonly emissionOf?: (id: string) => string | undefined },
): string;

/** What the instrument cannot tell you, as prose a rendering cannot omit. */
export function blindSpots(): readonly string[];
