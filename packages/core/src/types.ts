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

/**
 * What an adapter emits: everything that can be known from syntax alone.
 *
 * Confidence is assigned in two steps, and this is the first one. An adapter can
 * see that a path came from a static `import` — it cannot see whether that path
 * points at a file, because adapters never touch the filesystem. So it reports a
 * *ceiling* and the resolver decides the rest.
 */
export interface RawReference {
  /** Absolute path of the source file containing the reference. */
  readonly file: string;
  /** Start offset of the *path text only*, excluding surrounding quotes. */
  readonly start: number;
  /** End offset (exclusive) of the path text. */
  readonly end: number;
  /** The path exactly as written in the source. */
  readonly rawPath: string;
  readonly kind: ReferenceKind;
  /**
   * The best confidence this syntax could ever justify. The resolver assigns the
   * ceiling if the path resolves, and demotes to `unsafe` if it does not.
   */
  readonly ceiling: Confidence;
  /**
   * Whether the syntax *asserts* this is an asset reference.
   *
   * `true` for an `import`, an `<img src>`, a `url()` — the author said so, and an
   * unresolved one is a broken reference worth reporting. `false` for a
   * path-shaped string in JSON or Markdown, which is a guess: an unresolved one is
   * dropped from the graph rather than reported as broken, because otherwise every
   * `package.json` in the world produces false findings.
   */
  readonly asserted: boolean;
  /** Why this ceiling was assigned. Surfaced verbatim in the report. */
  readonly note?: string;
}

/**
 * Which of the four things the resolver concluded about a reference.
 *
 * The resolver knows this at the moment it decides, so it says so rather than
 * leaving `resolvedPath: null` to stand for three different outcomes that the
 * audit, the report and the planner would each have to tell apart again.
 */
export type Resolution =
  /** Points at an asset on disk. The only kind linked into the graph. */
  | 'resolved'
  /** Asserted by the syntax but pointing at nothing — a finding. */
  | 'broken'
  /** A path-shaped guess that did not resolve. Counted, never a finding. */
  | 'discarded'
  /** Alias-shaped (`@/…`, `~/…`, `#…`, bare). Its own bucket; Phase 2 resolves these. */
  | 'unresolved-alias';

/**
 * What the resolver produces: a raw reference plus what it points at.
 *
 * A union rather than a flat `resolution` field beside a nullable path, because it
 * makes `{ resolution: 'resolved', resolvedPath: null }` unrepresentable and lets
 * TypeScript narrow `resolvedPath` to `string` as soon as a consumer checks the
 * discriminator — no non-null assertions anywhere downstream.
 *
 * Keeping it separate from `RawReference` also means an adapter cannot produce a
 * resolved reference even by accident: only the resolver can widen one.
 */
export type Reference =
  | (RawReference & {
      readonly resolution: 'resolved';
      /** Equal to the raw reference's `ceiling`: it resolved, so the ceiling stands. */
      readonly confidence: Confidence;
      readonly resolvedPath: string;
    })
  | (RawReference & {
      readonly resolution: Exclude<Resolution, 'resolved'>;
      /** Nothing unresolved is ever rewritten, whatever its syntax promised. */
      readonly confidence: 'unsafe';
      readonly resolvedPath: null;
    });

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
  findReferences(input: { readonly file: string; readonly text: string }): RawReference[];
  rewrite(input: { readonly text: string; readonly edits: readonly Edit[] }): string;
}

/** An image file found on disk. */
export interface Asset {
  /** Absolute path with native separators. */
  readonly path: string;
  /** Path relative to the project root, POSIX-separated. The report key. */
  readonly relative: string;
  /** Lowercase extension including the dot. */
  readonly extension: string;
  /** Size on disk, from the `stat` taken during discovery. */
  readonly bytes: number;
}

/** A file some adapter claims and will be parsed for references. */
export interface SourceFile {
  /** Absolute path with native separators. */
  readonly path: string;
  /** Path relative to the project root, POSIX-separated. */
  readonly relative: string;
  /** Lowercase extension including the dot. */
  readonly extension: string;
  /** `Adapter.id` of the adapter that claimed this extension. */
  readonly adapterId: string;
}

/** Why discovery declined to look at something. */
export type SkipReason =
  /** A symlink or Windows junction. Not followed, to avoid cycles. */
  | 'symlink'
  /** A directory that could not be read (permissions, a vanished path). */
  | 'unreadable-directory'
  /** A file that could not be stat'ed or read. */
  | 'unreadable-file'
  /** A socket, FIFO, device, or Windows reparse point that is neither file nor directory. */
  | 'not-a-regular-file';

/**
 * One thing discovery could not process, with the reason.
 *
 * Rule 9: a silent skip is a P0 bug. Everything the walker declines ends up here
 * and is rendered in the report.
 */
export interface SkippedEntry {
  /** Absolute path with native separators. */
  readonly path: string;
  /** Path relative to the project root, POSIX-separated. */
  readonly relative: string;
  readonly reason: SkipReason;
  /** Human-readable specifics — typically an errno code such as `EACCES`. */
  readonly detail: string;
}

/** Everything a single filesystem walk found. */
export interface DiscoveryResult {
  /** Absolute, resolved project root. */
  readonly root: string;
  /** Image files, sorted by `relative`. */
  readonly assets: readonly Asset[];
  /** Adapter-claimed files, sorted by `relative`. */
  readonly sourceFiles: readonly SourceFile[];
  /**
   * How many entries an ignore rule excluded.
   *
   * An ignored directory counts once, not once per file inside it — we never look
   * inside, which is exactly why discovery is fast.
   */
  readonly ignoredCount: number;
  /** Everything skipped with a reason, sorted by `relative`. */
  readonly skipped: readonly SkippedEntry[];
}
