/**
 * The public data contracts of the engine.
 *
 * These types are the API. Everything else in core is a pure function over them,
 * which is what keeps the engine testable without touching a filesystem.
 *
 * A note on offsets: `start`/`end` are UTF-16 code-unit indices into the source
 * string — the same units every JavaScript parser and `String.prototype.slice`
 * use. They are deliberately NOT byte offsets: a file containing an emoji or a
 * non-ASCII path would desynchronise the two, and every rewrite after that point
 * would land in the wrong place.
 */

/** How certain we are that rewriting a reference is safe. */
export type Confidence =
  /** Static import/require that resolved to a file on disk. */
  | 'certain'
  /** String literal in a known attribute or function, resolved on disk. */
  | 'high'
  /** Template literal with a static prefix resolving to exactly one asset. */
  | 'medium'
  /** Dynamic or unresolvable. Never rewritten — always reported. */
  | 'unsafe';

/** The syntactic construct a reference was found in. */
export type ReferenceKind = 'import' | 'attr' | 'css-url' | 'md' | 'json' | 'template';

/** One place in one source file that points at an asset. */
export interface Reference {
  /** Absolute path of the source file containing the reference. */
  readonly file: string;
  /** Start offset of the *path text only*, excluding surrounding quotes. */
  readonly start: number;
  /** End offset (exclusive) of the path text. */
  readonly end: number;
  /** The path exactly as written in the source. */
  readonly rawPath: string;
  readonly kind: ReferenceKind;
  readonly confidence: Confidence;
  /** Why this confidence was assigned. Surfaced verbatim in the report. */
  readonly note?: string;
}

/** A range replacement in a single file. */
export interface Edit {
  /** Start offset, inclusive. */
  readonly start: number;
  /** End offset, exclusive. Equal to `start` for a pure insertion. */
  readonly end: number;
  /** Text to put in place of `[start, end)`. */
  readonly replacement: string;
}

/**
 * Reads one file format and finds asset references in it.
 *
 * Contract:
 * - An adapter never touches the filesystem.
 * - An adapter never resolves paths; it reports `rawPath` and the resolver decides.
 * - `findReferences` and `rewrite` are pure functions of their input.
 */
export interface Adapter {
  /** Stable id, e.g. 'jsx', 'html', 'css'. Used in config and reports. */
  readonly id: string;
  /** File extensions this adapter claims, lowercase and dot-prefixed: ['.html']. */
  readonly extensions: readonly string[];
  findReferences(input: { readonly file: string; readonly text: string }): Reference[];
  rewrite(input: { readonly text: string; readonly edits: readonly Edit[] }): string;
}
