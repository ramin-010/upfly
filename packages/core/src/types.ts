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
export type ReferenceKind =
  | 'import'
  | 'attr'
  | 'css-url'
  | 'md'
  | 'json'
  | 'template'
  /**
   * A path-shaped string literal in JavaScript or TypeScript, guessed rather than
   * asserted — the same standing as a string in a JSON file.
   */
  | 'string';

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
  /** Points at exactly one asset. */
  | 'resolved'
  /**
   * A `medium` template that glob-matched one or more assets.
   *
   * Separate from `resolved` because it carries several paths, and because Phase 2
   * must treat it differently: a pattern is only safe to rewrite if *every* asset it
   * matches converts to the same target extension.
   */
  | 'resolved-pattern'
  /**
   * The ceiling was already `unsafe`, so there was never a static path to resolve.
   *
   * Distinct from `broken` because the two are unlike: a literal path pointing at
   * nothing is a real, actionable finding, whereas `url($hero)` is simply not
   * knowable until the preprocessor runs — nobody typed a wrong path. This is also
   * the set shown to users as "N references I couldn't safely rewrite".
   */
  | 'dynamic'
  /**
   * Points at a real file the engine deliberately does not index.
   *
   * Its own outcome because none of the others can carry it honestly: `discarded` is
   * speculative-and-silent while this is asserted, `dynamic` means no static path
   * exists while this one is perfectly static, and folding it into `resolved` would
   * let Phase 2 rewrite it — breaking a reference that currently works, since the
   * target was never converted.
   */
  | 'out-of-scope'
  /** A real literal path that points at nothing — a finding. */
  | 'broken'
  /** A path-shaped guess that did not resolve. Counted, never a finding. */
  | 'discarded'
  /** Alias-shaped (`@/…`, `~/…`, `#…`, bare). Its own bucket; Phase 2 resolves these. */
  | 'unresolved-alias';

/**
 * How a reference reached the asset it points at.
 *
 * Recorded rather than left to be re-derived: Phase 2 needs it, and re-deriving
 * what the producer already knew is the mistake the ceiling/confidence split exists
 * to remove.
 *
 * The distinction that matters: a **`project-root`** resolution proves the asset is
 * alive but is **not strong enough to rewrite the reference**, because the code may
 * join that string to a different base entirely. The other two are safe to rewrite.
 */
export type ResolvedVia =
  /** Relative to the directory of the referencing file. The ordinary case. */
  | 'file'
  /** A root-relative path against a configured serving root. */
  | 'serving-root'
  /**
   * A root-relative path resolved against the project root, because no configured
   * serving root held it.
   *
   * ⚠️ **Split out from `speculative-root` by measurement (R36).** These were one
   * value, and treating them alike was costing real rewrites: across the five
   * validation repositories this case occurs **1,325** times and **1,267 of those are
   * `asserted`** — `<img src="/favicon.png">` in hand-written HTML, resolving to a
   * file that exists and that the site really does serve from the project root. A
   * plain static site with no build step has no public directory to configure, so
   * this is not a fallback *past* a statement; it is the ordinary answer.
   *
   * ⚠️ **It is not unconditionally strong, and the weak sub-case is unmeasured.** If a
   * serving root *is* configured and correct, a root-relative path that misses it and
   * happens to exist at the project root is a false link. **Zero occurrences across
   * all five repos** — in every repo whose serving root matched, the `serving-root`
   * candidate won first — so the risk is real but unevidenced. Whether this may be
   * rewritten is a policy question for the planner and is **open**; today it is
   * treated exactly as before.
   */
  | 'project-root'
  /**
   * A `./`-spelled **speculative** path that failed file-relative and was retried
   * against the project root — a guess at the base of a string that was already a
   * guess.
   *
   * Genuinely weak, and measured as rare: **10 occurrences across five repositories,
   * none of them `asserted`.** This is the case R15 was written about.
   */
  | 'speculative-root';

/**
 * What the resolver produces: a raw reference plus what it points at.
 *
 * A union rather than a flat `resolution` field beside a nullable path, because it
 * makes `{ resolution: 'resolved', resolvedPath: null }` unrepresentable and lets
 * TypeScript narrow the payload as soon as a consumer checks the discriminator — no
 * non-null assertions anywhere downstream.
 *
 * Ask `isLinked()` rather than comparing `resolution` by hand: there are two linked
 * outcomes, and testing for only one of them is a false negative the compiler cannot
 * see.
 *
 * Keeping this separate from `RawReference` also means an adapter cannot produce a
 * resolved reference even by accident: only the resolver can widen one.
 */
export type Reference =
  | (RawReference & {
      readonly resolution: 'resolved';
      /** Equal to the raw reference's `ceiling`: it resolved, so the ceiling stands. */
      readonly confidence: Confidence;
      readonly resolvedPath: string;
      readonly resolvedVia: ResolvedVia;
    })
  | (RawReference & {
      readonly resolution: 'resolved-pattern';
      /** Only a `medium` ceiling can reach the glob branch, so the type says so. */
      readonly confidence: 'medium';
      /** Every asset the pattern matched. Non-empty by construction. */
      readonly resolvedPaths: readonly [string, ...string[]];
      readonly resolvedVia: ResolvedVia;
    })
  | (RawReference & {
      readonly resolution: 'out-of-scope';
      /** The target is known, but it is never rewritten. */
      readonly confidence: 'unsafe';
      /** Where it points. We know exactly; we simply do not index it. */
      readonly resolvedPath: string;
      /** Which rule excluded the target, rendered verbatim in the report. */
      readonly exclusionReason: string;
    })
  | (RawReference & {
      readonly resolution: Exclude<Resolution, 'resolved' | 'resolved-pattern' | 'out-of-scope'>;
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

/**
 * Why a file the walk enumerated was never read for references.
 *
 * All three mean the same thing to the audit — *we did not learn what this file
 * references* — which is why they share one list rather than three. An asset whose
 * only mention lives in one of these files would otherwise be reported as
 * confidently dead, a false positive we manufactured ourselves.
 */
export type UnscannedReason =
  /** No adapter claims this extension: a `.vue`, a `.yaml`, an `.svg`. */
  | 'unclaimed-extension'
  /** An adapter claimed it and could not parse it. */
  | 'parse-failed'
  /** It could not be read at all — typically it vanished mid-run. */
  | 'unreadable';

/**
 * A file the engine saw but did not scan.
 *
 * Carries the path, not just the extension, because the audit sweeps these files
 * for the filenames of zero-reference assets. Hedging is per-asset — an asset named
 * in an unscanned file is `possibly-dead` *and the report says which file*, while
 * everything else is confidently `dead`. A global hedge keyed on "some extension
 * went unread" fires on every real repository and therefore says nothing.
 */
export interface UnscannedFile {
  /** Absolute path with native separators. */
  readonly path: string;
  /** Path relative to the project root, POSIX-separated. */
  readonly relative: string;
  /** Lowercase extension including the dot, or `''` if there is none. */
  readonly extension: string;
  readonly reason: UnscannedReason;
  /** Parser message or errno code. `''` when the reason needs no detail. */
  readonly detail: string;
}

/** How many files of one extension went unscanned. The report's coverage statement. */
export interface UnscannedExtension {
  /** Lowercase extension including the dot, or `''` for files without one. */
  readonly ext: string;
  readonly fileCount: number;
}

/**
 * A directory the walk refused to descend into, and the rule that stopped it.
 *
 * Recorded because the resolver needs it: a reference into an excluded directory
 * points at a file that really is there, so calling it `broken` is a false positive.
 * The likeliest case is not `node_modules` but a user who puts `legacy/` in
 * `.upflyignore` while `legacy/` is still referenced.
 */
export interface ExcludedRoot {
  /** Absolute path with native separators. */
  readonly path: string;
  /** Path relative to the project root, POSIX-separated. */
  readonly relative: string;
  /** The rule that excluded it, phrased for a report. */
  readonly reason: string;
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
  /**
   * Every directory the walk descended into, POSIX-relative to `root` and sorted.
   * The root itself is not included.
   *
   * Recorded rather than derived from the paths in `assets` and `sourceFiles`, and
   * the difference is not theoretical: a directory holding only files nothing tracks
   * leaves no trace in either list. Measured on `shadcn-ui`, deriving finds 11 of its
   * 12 serving roots, because `templates/next-app/public` holds a single `.gitkeep`.
   * A recorded list cannot disagree with the walk, because it is the walk.
   *
   * Excluded directories are absent: the walk never entered them, and serving-root
   * detection reading them would contradict the ignore rules.
   */
  readonly directories: readonly string[];
  /**
   * Files no adapter claimed, sorted by `relative`.
   *
   * Excluded and ignored entries are deliberately absent: an ignore rule is an
   * instruction, not a gap in our coverage, and walking a pruned `node_modules` to
   * hedge a report would be absurd. Those are reported once, as `excludedRoots`.
   *
   * `.svg` appears here *and* in `assets`. It is both an asset and a container —
   * `<image href>`, `<use href>` and a `<style>` block inside one are all real
   * references, and no adapter reads them.
   */
  readonly unscannedFiles: readonly UnscannedFile[];
  /**
   * Directories the walk did not descend into, with the rule that excluded each.
   *
   * The resolver prefix-tests references against these so that a path into an
   * excluded directory is reported as `out-of-scope` rather than `broken`.
   */
  readonly excludedRoots: readonly ExcludedRoot[];
}
