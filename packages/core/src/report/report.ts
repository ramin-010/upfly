/**
 * Assembles everything a run learned into the report people and agents read.
 *
 * The JSON is public API: versioned, snapshot-tested, and changed only on purpose. No
 * absolute path may reach it, though much of the data upstream carries one beside a POSIX
 * `relative`; a test greps the serialised report for the root. The same input gives a
 * byte-identical report, so every list is sorted and nothing depends on time or locale.
 * Every stage's skips land in one `skipped` list, each with a reason. See "The report" in
 * ARCHITECTURE.md.
 */

import { NO_REFERENCE_TO_FIND } from '../adapters/html.js';
import { interpolationChunks, templateExpressionReason } from '../adapters/reference-path.js';
import type { AuditResult, DeadFinding, Finding, PossiblyDeadFinding } from '../audit/audit.js';
import type { Mention, SweepResult } from '../audit/sweep.js';
import { formatBytes, plural } from '../format.js';
import type { Graph } from '../graph/graph.js';
import { countExtensions, groupUnscanned } from '../graph/unscanned.js';
import {
  compareStrings,
  extensionOf,
  isImageExtension,
  isVectorExtension,
  relativePath,
  toPosix,
} from '../paths.js';
import { MENTION_SURVIVES } from '../plan/plan.js';
import type { AssetProbe, EncodeFormat, EncodeSetting, ProbeSkipCode } from '../probe/probe.js';
import type { AliasMap } from '../resolve/aliases.js';
import { isLinked, provenPath } from '../resolve/reference.js';
import type { ServingRoots } from '../resolve/resolve.js';
import type {
  Confidence,
  DiscoveryResult,
  Reference,
  Resolution,
  ResolvedVia,
  UnscannedExtension,
} from '../types.js';
import type { Declined } from '../write/manifest.js';

/**
 * The report's schema version, carried in `Report.version`.
 *
 * Bumped when a field changes meaning or disappears, never for an addition, since a
 * consumer that ignores unknown fields keeps working. A change to an exported TypeScript
 * type that the JSON does not show, such as a new `ProbeSkipCode`, is versioned with the
 * package instead.
 */
export const REPORT_SCHEMA_VERSION = 7;

/** The run's headline numbers. */
export interface ReportSummary {
  readonly assets: number;
  readonly assetBytes: number;
  readonly sourceFiles: number;
  /** Every reference, leaving out the values an adapter declined (`references.declinedValues`). */
  readonly references: number;
  /** References linked to an asset, pattern references included. */
  readonly linkedReferences: number;
  /** Assets with at least one reference. */
  readonly referencedAssets: number;
  readonly findings: Readonly<Record<Finding['kind'], number>>;
  /**
   * The best measured saving per asset, summed. The best rather than the total, so an
   * asset measured against both webp and avif counts once.
   */
  readonly potentialSavingBytes: number;
  /**
   * Every setting each format's savings were measured at, sorted and deduplicated. Empty
   * when there is no format opportunity.
   *
   * A saving means little without its setting, and the setting varies per image: a PNG's
   * webp saving is measured lossless when that encode is smaller. Taken from the
   * measurements rather than the configuration, so it describes the run that produced
   * `potentialSavingBytes`.
   */
  readonly savingQuality: Readonly<Partial<Record<EncodeFormat, readonly EncodeSetting[]>>>;
  /** `false` when the run was `--no-probe`; oversized and opportunities are absent. */
  readonly probed: boolean;
  /**
   * Images with no measurement for a reason `skipped` lists: the header or the encode
   * failed, or converting would lose an animation. The encode cap's images are counted by
   * the `encode-capped` caveat instead, and an image that needed no measurement is not
   * counted. Zero when the run did not probe.
   */
  readonly unmeasuredAssets: number;
}

/**
 * How a reference is scored: whether it had an answer, and whether the engine gave one.
 *
 * |  | the engine answered | the engine refused |
 * |---|---|---|
 * | there is an answer | `resolved-with-an-answer` | `missed-with-an-answer` |
 * | there is no answer | a wrong answer | `correctly-refused` |
 *
 * The engine cannot report its own wrong answers, since it believes each one, so that box
 * has no value here: counting it takes an independent check such as `bench/src/verify.ts`.
 * See "Scoring references for accuracy" in ARCHITECTURE.md.
 */
export type ReferenceClass =
  /** The engine found where it points. Includes `broken`: the target is known, and missing. */
  | 'resolved-with-an-answer'
  /** An answer existed and the engine did not find it. */
  | 'missed-with-an-answer'
  /** No answer existed, and the engine declined for a reason it can name. */
  | 'correctly-refused'
  /**
   * A path-shaped guess nobody asserted, such as a string in a lockfile. Left out of both
   * accuracy figures, since it was never a claim about an asset.
   */
  | 'not-a-claim';

/**
 * The closed list of properties that prove a reference has no answer.
 *
 * Each names a property of the reference itself, such as its text or where it points,
 * never a limit of the engine. Adding one moves references from
 * `missed-with-an-answer` to `correctly-refused` and raises the accuracy figure, so it has
 * to be a visible edit to this list.
 */
const REFUSAL_REASONS: ReadonlyArray<{
  readonly id: string;
  readonly holds: (reference: Reference) => boolean;
  /**
   * What this reason is known to over-claim, as measured, or `null` when nothing is known.
   * It reaches the report beside the count, so the known error travels with the figure.
   */
  readonly bound: string | null;
  /**
   * What the bound was measured against, and when. Set it whenever `bound` is set, so a
   * reader can tell when the measurement no longer describes the engine or the repositories.
   */
  readonly measuredAgainst: string | null;
}> = [
  {
    // The target is known but outside what Upfly acts on (an excluded directory, a
    // package), so nothing was missed.
    id: 'out-of-scope',
    holds: (reference) => reference.resolution === 'out-of-scope',
    bound: null,
    measuredAgainst: null,
  },
  {
    // The path does not exist until something renders it. Two checks, because they read
    // different text: `templateExpressionReason` finds a hole of any syntax in the source
    // text, and `interpolationChunks` finds one in the assembled path when there is one,
    // since a `+` chain's source text holds no `${`.
    id: 'assembled-at-runtime',
    holds: (reference) =>
      reference.resolution === 'dynamic' &&
      (templateExpressionReason(reference.rawPath) !== null ||
        interpolationChunks(provenPath(reference)).length > 1),
    bound:
      'Of 18 such references, 14 are a parameter, a prop or instance state, which nothing reaches, but 4 are not. Two read an imported module constant, which a module graph would resolve (to an absolute URL); one is a filename from a build-time glob; one is an environment variable the deploy supplies. The first three have an answer we do not compute, so they are misses this reason absorbs. Read as roughly four in five.',
    measuredAgainst:
      '2026-09-25, on five public repositories: astro-docs, eleventy-docs, shadcn-ui, railsgirls-com and scratch-www. If they or the engine have changed since, this bound has not been re-measured.',
  },
  {
    // CSS the HTML adapter could not read, in a style attribute or a `<style>` element, that
    // holds no url-taking function, so there is no reference in it to find. The adapter
    // decides that and ends its note with `NO_REFERENCE_TO_FIND`; this reads it rather than
    // deciding again.
    id: 'no-reference-in-it-to-find',
    holds: (reference) =>
      reference.unread === true && (reference.note ?? '').endsWith(NO_REFERENCE_TO_FIND),
    bound: null,
    measuredAgainst: null,
  },
];

/**
 * Which accuracy class a reference falls in. `broken` counts as `resolved-with-an-answer`:
 * the engine found where the reference points, and the missing file is the project's
 * defect, not a miss.
 */
export function classifyReference(reference: Reference): ReferenceClass {
  if (reference.resolution === 'discarded') return 'not-a-claim';
  if (
    reference.resolution === 'resolved' ||
    reference.resolution === 'resolved-pattern' ||
    reference.resolution === 'broken'
  ) {
    return 'resolved-with-an-answer';
  }

  for (const reason of REFUSAL_REASONS) {
    if (reason.holds(reference)) return 'correctly-refused';
  }

  // Anything no reason explains counts as a miss. That includes an `unresolved-alias` (a
  // bundler config Upfly did not read may resolve it), a path whose character references
  // cannot be located exactly, and a style attribute that could not be read but holds a
  // url-taking function.
  return 'missed-with-an-answer';
}

/** The reason id that classified this reference as refused, for the itemised list. */
export function refusalReasonId(reference: Reference): string | null {
  for (const reason of REFUSAL_REASONS) {
    if (reason.holds(reference)) return reason.id;
  }
  return null;
}

/** One reference the engine declined to link, listed rather than merely counted. */
export interface ReferenceEntry {
  /** POSIX-relative source file. */
  readonly file: string;
  readonly rawPath: string;
  readonly resolution: Resolution;
  /**
   * The exclusion rule for `out-of-scope`; for `unresolved-alias`, why no alias Upfly reads
   * maps it, naming any config covering the file whose aliases Upfly could not read; otherwise
   * the adapter's note or a default.
   */
  readonly reason: string;
  /**
   * The reference's accuracy class. The engine decides it once, so consumers do not each
   * keep a copy of the rule that could drift.
   */
  readonly classification: ReferenceClass;
  /**
   * The reason that made this a correct refusal, or `null` when it is not one. Each
   * refusal is listed with its reason, not only counted, so a reader can dispute one.
   */
  readonly refusalReason: string | null;
}

/** A refusal reason this run relied on, and what it is known to get wrong. */
export interface ClassificationBound {
  readonly reason: string;
  /** How many references this run classified with it. */
  readonly count: number;
  /** The measured over-claim, in words a reader can check. */
  readonly bound: string;
  /**
   * What that measurement was taken against, and when, so a reader can tell whether it
   * still applies.
   */
  readonly measuredAgainst: string;
}

/**
 * The report's references: counted by outcome, confidence and class, with each one Upfly could not
 * link listed.
 */
export interface ReferenceReport {
  readonly byResolution: Readonly<Record<Resolution, number>>;
  readonly byConfidence: Readonly<Record<Confidence, number>>;
  /**
   * How each linked reference reached its target, counted. A link found by guessing at the
   * base proves the asset is used but does not license rewriting the text, and these counts
   * are how a consumer tells such links from ordinary ones. They sum to the `resolved` and
   * `resolved-pattern` entries of `byResolution`. See "A link says the asset is alive;
   * `resolvedVia` says whether the text may be edited" in ARCHITECTURE.md.
   */
  readonly byResolvedVia: Readonly<Record<ResolvedVia, number>>;
  /**
   * Every reference counted in exactly one accuracy class. Resolution accuracy is
   * `resolved-with-an-answer` over itself plus `missed-with-an-answer`. Refusal accuracy
   * cannot be computed from the report: it needs the references the engine answered
   * wrongly, which only an independent check can find.
   */
  readonly byClassification: Readonly<Record<ReferenceClass, number>>;
  /**
   * Always `true`. It marks the missing refusal accuracy as a decision rather than an
   * oversight; see {@link byClassification}.
   */
  readonly refusalAccuracyIsNotSelfAssessable: true;
  /**
   * The refusal reasons this run used that are known to over-claim, with their measurement.
   * An entry means `correctly-refused` is too high, and `missed-with-an-answer` too low, by
   * what its bound describes. Empty means no reason in use is known to over-claim, not that
   * the figures are exact.
   */
  readonly classificationBounds: readonly ClassificationBound[];
  /**
   * Every `dynamic`, `unresolved-alias` and `out-of-scope` reference, listed in full: the
   * references Upfly could not safely rewrite. `broken` references are findings instead,
   * each a `broken` finding or an entry in a `serving-root-unknown` finding's `suppressed`.
   * A reference into what the project's own rules left out is in `leftOut` instead.
   */
  readonly unsafe: readonly ReferenceEntry[];
  /**
   * Every `out-of-scope` reference into what the project's own ignore rules left out, such
   * as an image passed to `--exclude`: the run was told to leave its target alone, so it
   * wants no answer. Each `reason` names the rule, or says an ignore rule left the image out.
   * A directory pruned by name, such as `node_modules`, is not the project's rule, and a
   * reference into one stays in `unsafe`.
   */
  readonly leftOut: readonly ReferenceEntry[];
  /**
   * Speculative path-shaped strings that did not resolve.
   *
   * Counted rather than listed by default: a large repository produces thousands
   * from lockfiles and i18n bundles, and listing them would bury everything else.
   */
  readonly discardedCount: number;
  /**
   * The discarded candidates themselves when `includeDiscarded` asked for them, otherwise
   * `null`, since an empty array would read as "there were none". If the JSON adapter ever
   * swallows real references, the count shows something is wrong and only this list shows
   * what.
   */
  readonly discarded: readonly ReferenceEntry[] | null;
  /**
   * Path-shaped values with an image extension that an adapter declined to read as a path,
   * such as a tooltip or a component's own prop naming an image. None is linked or rewritten.
   * They are not references, so every count above leaves them out.
   */
  readonly declinedValues: DeclinedValueReport;
}

/** The values an adapter declined, counted by reason. */
export interface DeclinedValueReport {
  readonly count: number;
  /** One entry per reason, the most common first, then by reason. */
  readonly byReason: readonly DeclinedValueCount[];
  /**
   * Each value, when `includeDiscarded` asked for them, otherwise `null`, since an empty
   * array would read as "there were none".
   */
  readonly values: readonly DeclinedValueEntry[] | null;
}

/** How many declined values share one reason. */
export interface DeclinedValueCount {
  /** The adapter's reason, one wording per construct and name. */
  readonly reason: string;
  readonly count: number;
}

/** One value an adapter declined to read as a path. */
export interface DeclinedValueEntry {
  /** POSIX-relative source file. */
  readonly file: string;
  /** The value's text as written. */
  readonly rawPath: string;
  readonly reason: string;
}

/** What the engine did not read, and what it refused to enter. */
export interface CoverageReport {
  readonly unscannedExtensions: readonly UnscannedExtension[];
  readonly unscannedFileCount: number;
  readonly excludedRoots: readonly { readonly path: string; readonly reason: string }[];
  /**
   * The serving roots that root-relative paths such as `/hero.png` were resolved against,
   * and whether the project declared them or the engine worked them out, so a guess never
   * passes for a declaration. It is the value the resolver was given, so the report cannot
   * describe a different run.
   */
  readonly servingRoots: ServingRoots;
  /**
   * Mechanisms this run did not use, as distinct from references it refused. A refusal is
   * in `unsafe` with a reason; a mechanism that never ran was not tested either way, so a
   * clean result says nothing about it.
   */
  readonly notExercised: readonly NotExercised[];
}

/** One mechanism this run did not put to work, and why not. */
export interface NotExercised {
  /** A stable id a consumer can match on: `serving-root-detection` or `probe`. */
  readonly mechanism: string;
  /** Why it did not run: a fact about this run's inputs, never about the engine. */
  readonly why: string;
}

/** Where a skip happened, so a reader can tell a parse failure from a bad symlink. */
export type SkipStage = 'discovery' | 'scan' | 'sweep' | 'citation' | 'measurement' | 'aliases';

/** One thing the engine declined to do, and why. */
export interface SkippedItem {
  /** POSIX-relative path of the file or asset involved. */
  readonly what: string;
  readonly stage: SkipStage;
  readonly reason: string;
}

/**
 * One unreferenced vector, as listed when `includeUnusedVectors` is set.
 *
 * A union like the findings it comes from, so a `possibly-dead` entry cannot lack its
 * evidence. It keeps everything the finding carried because `bench/src/verify.ts` checks
 * these entries exactly as it checks `findings`.
 */
export type UnusedVectorEntry =
  | {
      readonly kind: 'dead';
      /** POSIX-relative path. */
      readonly asset: string;
      readonly bytes: number;
    }
  | {
      readonly kind: 'possibly-dead';
      readonly asset: string;
      readonly bytes: number;
      /** Why it was hedged. Non-empty by construction, exactly as on the finding. */
      readonly evidence: readonly [Mention, ...Mention[]];
    };

/**
 * The assets a plan examined and did not convert.
 *
 * Shaped like `unusedVectors`: a count with the total size, itemised with each reason only
 * on request. Zero for an audit-only run, which makes no plan.
 */
export interface DeclinedReport {
  readonly count: number;
  /** Their total size: the fact that turns a count into something worth reading. */
  readonly bytes: number;
  /**
   * The assets themselves, when `includeDeclined` asked for them.
   *
   * `null` rather than `[]` when not requested, for the reason the other two use it:
   * an empty array reads as "there were none".
   */
  readonly assets: readonly DeclinedEntry[] | null;
}

export interface DeclinedEntry {
  /** POSIX-relative path. */
  readonly asset: string;
  readonly bytes: number;
  /** Why the planner did not convert it, in the planner's own words. */
  readonly reason: string;
}

/** The references a plan examined and left as written. */
export interface DeclinedReferencesReport {
  readonly count: number;
  /** Each one, or `null` unless `includeDeclined` asked for the list. */
  readonly references: readonly DeclinedReferenceEntry[] | null;
}

/** One reference a plan left as written. */
export interface DeclinedReferenceEntry {
  /** POSIX-relative path of the file that holds it. */
  readonly file: string;
  /** Its line, when the planner recorded one. */
  readonly line: number | null;
  /** Why the planner left it as written, in the planner's own words. */
  readonly reason: string;
}

/**
 * An original that `optimize` kept beside its converted file. The references moved to the
 * converted file, so nothing links to the original and the audit found it `dead`; but it
 * is there because the run was asked to keep originals, so it is not listed as unused.
 */
export interface KeptOriginalEntry {
  /** POSIX-relative path of the original. */
  readonly asset: string;
  readonly bytes: number;
  /** The converted file beside it, which the references link to. */
  readonly convertedTo: string;
}

export interface KeptOriginalReport {
  readonly count: number;
  readonly bytes: number;
  readonly assets: readonly KeptOriginalEntry[];
}

export interface UnusedVectorReport {
  readonly count: number;
  /** Their total size, which is the fact that makes the count actionable. */
  readonly bytes: number;
  /**
   * The vectors themselves when `includeUnusedVectors` asked for them, otherwise `null`,
   * since an empty array would read as "there were none".
   */
  readonly assets: readonly UnusedVectorEntry[] | null;
}

/**
 * An unreferenced vector beside a broken reference to a raster with the same name, such as
 * `hero.svg` and a broken `hero.png`. Together they suggest a conversion done by hand with
 * the reference left behind, which gives the vector an action, so it stays in `findings`.
 * The report states the two facts and leaves the conclusion to the reader.
 */
export interface StaleConversion {
  /** POSIX-relative path of the unreferenced vector. */
  readonly vector: string;
  /** The broken reference's path exactly as written. */
  readonly rawPath: string;
  /** `file:line` of the broken reference, so the reader can open it. */
  readonly where: string;
}

/** A limitation that applies to the report as a whole rather than to one finding. */
export interface Caveat {
  readonly code:
    | 'public-dir-dead'
    | 'framework-conventions'
    | 'nothing-to-measure'
    | 'not-probed'
    /**
     * Duplicates were not looked for, which is not the same as none being found. Without
     * this caveat the report would show no duplicates and read as clean.
     */
    | 'duplicates-not-checked'
    | 'encode-capped'
    | 'excluded-roots'
    | 'replace-held-back'
    | 'unscanned-extensions'
    | 'binary-file-types'
    | 'svg-both-ways'
    | 'unused-vectors';
  readonly count: number;
  /**
   * Rendered verbatim, and complete on its own.
   *
   * The count is interpolated into it rather than left for a renderer to prefix:
   * an agent reading the JSON gets a sentence it can quote, and a person is never
   * shown a bare `3:` to interpret.
   */
  readonly message: string;
  /**
   * The specifics, when a count alone would not be actionable.
   *
   * "no adapter reads these file types" is a shrug; naming `.njk` and its file count is
   * how a user finds out which adapter they want.
   */
  readonly detail: readonly string[];
}

/**
 * The audit's report, as `upfly audit --json` prints it: headline numbers, findings, and every
 * reference and image Upfly declined, each with its reason. The `upfly` package ships its JSON
 * Schema, `schema/report.json`.
 */
export interface Report {
  readonly version: number;
  readonly summary: ReportSummary;
  /**
   * Every finding there is something to do about, in the audit's order. Not every finding
   * the audit produced: an unreferenced vector moves to `unusedVectors` unless it is part of
   * a stale conversion, and an original kept beside its linked converted file moves to
   * `keptOriginals`. `summary.findings` counts this array. See "`findings` holds what there
   * is something to do about" in ARCHITECTURE.md.
   */
  readonly findings: readonly Finding[];
  /**
   * The unreferenced vectors this report does not itemise, with their total size: Upfly
   * neither converts a vector nor deletes an asset, so it has no action to offer for them.
   */
  readonly unusedVectors: UnusedVectorReport;
  /** Originals kept beside the converted file their references now use. */
  readonly keptOriginals: KeptOriginalReport;
  /** The assets a plan examined and did not convert. */
  readonly declined: DeclinedReport;
  /**
   * The references a plan left as written, each with the planner's reason, such as a
   * pattern whose text cannot be repointed. Kept apart from `declined`, which holds images.
   */
  readonly declinedReferences: DeclinedReferencesReport;
  /** Unreferenced vectors beside a broken reference to their raster twin. */
  readonly staleConversions: readonly StaleConversion[];
  readonly references: ReferenceReport;
  readonly coverage: CoverageReport;
  /** Everything declined, from every stage, sorted. */
  readonly skipped: readonly SkippedItem[];
  /**
   * The file holding what the third-party libraries said during the run, or `null`. Their
   * wording changes between versions, so it stays out of the report, and this name tells a
   * reader where it went. See "The recorded reason is ours, and the library's is not in the
   * report" in ARCHITECTURE.md.
   */
  readonly diagnosticsFile: string | null;
  readonly caveats: readonly Caveat[];
}

/**
 * What `buildReport` reads: the output of `runPipeline`, and what to list in full.
 */
export interface ReportInput {
  readonly graph: Graph;
  readonly audit: AuditResult;
  /** For the entries only discovery saw: symlinks, unreadable files, pruned roots. */
  readonly discovery: DiscoveryResult;
  readonly sweep: SweepResult;
  /**
   * The serving roots the resolver was given, passed on rather than re-derived. Required,
   * so no caller can build a report that passes a guessed root off as a declared one.
   */
  readonly servingRoots: ServingRoots;
  /**
   * The aliases the resolver was given. Required, so every alias setting Upfly found and could
   * not read reaches `skipped`.
   */
  readonly aliases: AliasMap;
  /** Absent for a `--no-probe` run. */
  readonly probes?: readonly AssetProbe[];
  /**
   * Include the discarded candidates in full (`--include-discarded`). Off by default,
   * because the list is usually thousands of lockfile strings.
   */
  readonly includeDiscarded?: boolean;
  /**
   * List the unreferenced vectors counted in `unusedVectors` (`--include-unused-svg`). Off
   * by default, since there is no action to offer for any of them.
   */
  readonly includeUnusedVectors?: boolean;
  /**
   * What a plan declined, if one was made.
   *
   * Absent for an audit-only run, which has no plan and therefore nothing to decline.
   * Bytes are not carried on `Declined` itself: they are looked up in the graph here,
   * so the manifest schema does not gain a field for the report's benefit.
   */
  readonly declined?: readonly Declined[];
  /** Itemise the declined assets. Off by default (`--include-declined`). */
  readonly includeDeclined?: boolean;
  /**
   * The name of the file this run wrote the libraries' own messages to. Leave it out when
   * no such file is written, so the report does not send a reader looking for nothing. A
   * name rather than a path, so the report is the same from any checkout.
   */
  readonly diagnosticsFile?: string;
}

/**
 * Build the report from the results of a run, such as `runPipeline`'s output. Pure, and the
 * only place that decides the report's public shape.
 */
export function buildReport(input: ReportInput): Report {
  const vectors = partitionUnusedVectors(input.audit.findings);
  const originals = partitionKeptOriginals(vectors.itemised, input.graph);

  return {
    version: REPORT_SCHEMA_VERSION,
    // The itemised set, not `audit.findings`: the summary counts what the report
    // shows, so a reader can never add up the findings and get a different number
    // from the one in the headline.
    summary: summarise(input, originals.itemised),
    findings: originals.itemised,
    unusedVectors: {
      count: vectors.demoted.length,
      bytes: vectors.demoted.reduce((total, entry) => total + entry.bytes, 0),
      assets: input.includeUnusedVectors ? vectors.demoted : null,
    },
    keptOriginals: {
      count: originals.kept.length,
      bytes: originals.kept.reduce((total, entry) => total + entry.bytes, 0),
      assets: originals.kept,
    },
    staleConversions: vectors.staleConversions,
    declined: declinedReport(input),
    declinedReferences: declinedReferencesReport(input),
    references: referenceReport(
      input.graph,
      input.aliases,
      input.includeDiscarded ?? false,
      leftOutBy(input.discovery),
    ),
    coverage: coverageReport(input),
    skipped: collectSkips(input),
    diagnosticsFile: input.diagnosticsFile ?? null,
    caveats: caveats(input, vectors, originals.kept),
  };
}

/** The last path segment. Either separator counts, since a raw path is as written. */
function baseNameOf(rawPath: string): string {
  const cut = Math.max(rawPath.lastIndexOf('/'), rawPath.lastIndexOf('\\'));
  return cut === -1 ? rawPath : rawPath.slice(cut + 1);
}

/** The filename without its extension. `''` for a dotfile, which pairs with nothing. */
function stemOf(rawPath: string): string {
  const base = baseNameOf(rawPath);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(0, dot);
}

function isUnusedVector(finding: Finding): finding is DeadFinding | PossiblyDeadFinding {
  return (
    (finding.kind === 'dead' || finding.kind === 'possibly-dead') &&
    isVectorExtension(extensionOf(finding.asset))
  );
}

/** A broken reference, reduced to what a stale conversion reports. */
interface BrokenRaster {
  readonly rawPath: string;
  readonly where: string;
}

/**
 * Broken references to a raster, indexed by filename stem. A broken reference to a vector
 * says nothing about a conversion: framework scaffolds reference `/next.svg` and
 * `/vite.svg`, and pairing those with unreferenced vectors of the same name would invent
 * conversions.
 */
function brokenRasterStems(findings: readonly Finding[]): ReadonlyMap<string, BrokenRaster[]> {
  const byStem = new Map<string, BrokenRaster[]>();
  for (const finding of findings) {
    if (finding.kind !== 'broken') continue;
    const extension = extensionOf(baseNameOf(finding.rawPath));
    if (!isImageExtension(extension) || isVectorExtension(extension)) continue;
    const stem = stemOf(finding.rawPath);
    if (stem === '') continue;
    byStem.set(stem, [
      ...(byStem.get(stem) ?? []),
      { rawPath: finding.rawPath, where: finding.where },
    ]);
  }
  return byStem;
}

/** The stale conversions, and the vectors they keep itemised. */
function findStaleConversions(findings: readonly Finding[]): {
  staleConversions: readonly StaleConversion[];
  paired: ReadonlySet<string>;
} {
  const byStem = brokenRasterStems(findings);
  const staleConversions: StaleConversion[] = [];
  const paired = new Set<string>();

  for (const finding of findings) {
    if (!isUnusedVector(finding)) continue;
    // Stems match exactly, case included: `Hero.png` and `hero.png` can be two files, and
    // a wrong hint costs more trust than a missing one.
    for (const broken of byStem.get(stemOf(finding.asset)) ?? []) {
      staleConversions.push({
        vector: finding.asset,
        rawPath: broken.rawPath,
        where: broken.where,
      });
      paired.add(finding.asset);
    }
  }

  staleConversions.sort(
    (a, b) =>
      compareStrings(a.vector, b.vector) ||
      compareStrings(a.rawPath, b.rawPath) ||
      compareStrings(a.where, b.where),
  );
  return { staleConversions, paired };
}

/** One demoted vector, keeping everything the finding carried. */
function asUnusedVector(finding: DeadFinding | PossiblyDeadFinding): UnusedVectorEntry {
  return finding.kind === 'dead'
    ? { kind: 'dead', asset: finding.asset, bytes: finding.bytes }
    : {
        kind: 'possibly-dead',
        asset: finding.asset,
        bytes: finding.bytes,
        evidence: finding.evidence,
      };
}

/**
 * Splits the findings into those the report itemises and the unused vectors it only
 * counts. Stale conversions are found first, since a paired vector stays itemised.
 */
function partitionUnusedVectors(findings: readonly Finding[]): {
  itemised: readonly Finding[];
  demoted: readonly UnusedVectorEntry[];
  staleConversions: readonly StaleConversion[];
} {
  const { staleConversions, paired } = findStaleConversions(findings);

  const itemised: Finding[] = [];
  const demoted: UnusedVectorEntry[] = [];
  for (const finding of findings) {
    if (isUnusedVector(finding) && !paired.has(finding.asset)) {
      demoted.push(asUnusedVector(finding));
    } else {
      itemised.push(finding);
    }
  }

  return { itemised, demoted, staleConversions };
}

/**
 * Separates the `dead` rasters whose converted file sits beside them and is linked: the
 * same path with `.webp` or `.avif`. Those are originals `optimize` kept on purpose.
 */
function partitionKeptOriginals(
  findings: readonly Finding[],
  graph: Graph,
): { itemised: readonly Finding[]; kept: readonly KeptOriginalEntry[] } {
  const linked = new Set(
    graph.assets.filter((node) => node.references.length > 0).map((node) => node.asset.relative),
  );
  const itemised: Finding[] = [];
  const kept: KeptOriginalEntry[] = [];
  for (const finding of findings) {
    const convertedTo = finding.kind === 'dead' ? linkedConversionOf(finding.asset, linked) : null;
    if (convertedTo === null || finding.kind !== 'dead') itemised.push(finding);
    else kept.push({ asset: finding.asset, bytes: finding.bytes, convertedTo });
  }
  return { itemised, kept };
}

function linkedConversionOf(asset: string, linked: ReadonlySet<string>): string | null {
  const dot = asset.lastIndexOf('.');
  if (dot <= asset.lastIndexOf('/')) return null;
  const extension = asset.slice(dot).toLowerCase();
  for (const converted of ['.webp', '.avif']) {
    const target = `${asset.slice(0, dot)}${converted}`;
    if (converted !== extension && linked.has(target)) return target;
  }
  return null;
}

function summarise(input: ReportInput, findings: readonly Finding[]): ReportSummary {
  const counts: Record<Finding['kind'], number> = {
    'serving-root-unknown': 0,
    broken: 0,
    dead: 0,
    'possibly-dead': 0,
    oversized: 0,
    'format-opportunity': 0,
    duplicate: 0,
  };
  for (const finding of findings) counts[finding.kind] += 1;

  const bestSaving = new Map<string, number>();
  const settings = new Map<EncodeFormat, Set<EncodeSetting>>();
  for (const finding of findings) {
    if (finding.kind !== 'format-opportunity') continue;
    bestSaving.set(finding.asset, Math.max(bestSaving.get(finding.asset) ?? 0, finding.savedBytes));
    const seen = settings.get(finding.to) ?? new Set<EncodeSetting>();
    seen.add(finding.quality);
    settings.set(finding.to, seen);
  }

  const savingQuality: Partial<Record<EncodeFormat, readonly EncodeSetting[]>> = {};
  for (const [format, seen] of settings) {
    // A fixed order, so the output is byte-identical: numbers ascending, then `'lossless'`.
    savingQuality[format] = [...seen].sort((a, b) => {
      if (a === b) return 0;
      if (a === 'lossless') return 1;
      if (b === 'lossless') return -1;
      return a - b;
    });
  }

  return {
    assets: input.graph.assets.length,
    assetBytes: input.graph.assets.reduce((total, node) => total + node.asset.bytes, 0),
    sourceFiles: input.discovery.sourceFiles.length,
    references: liveReferences(input.graph).length,
    linkedReferences:
      input.graph.byResolution.resolved.length +
      input.graph.byResolution['resolved-pattern'].length,
    referencedAssets: input.graph.assets.filter((node) => node.references.length > 0).length,
    findings: counts,
    potentialSavingBytes: [...bestSaving.values()].reduce((total, bytes) => total + bytes, 0),
    savingQuality,
    probed: input.audit.probed,
    unmeasuredAssets: (input.probes ?? []).filter((probe) =>
      probe.skipped.some(
        (skip) =>
          skip.code !== 'beyond-encode-cap' && !DETERMINED_NOT_WORTH_MEASURING.has(skip.code),
      ),
    ).length,
  };
}

/**
 * The graph's references, less the values an adapter declined. A declined value reaches the
 * graph as `discarded`, so the sweep can read what it names, but it is not a reference, and
 * the report counts it apart (`declinedValues`).
 */
function liveReferences(graph: Graph): readonly Reference[] {
  return graph.references.filter((reference) => reference.declined !== true);
}

function referenceReport(
  graph: Graph,
  aliases: AliasMap,
  includeDiscarded: boolean,
  leftOutReason: (reference: Reference) => string | null,
): ReferenceReport {
  const references = liveReferences(graph);
  const discardedReferences = references.filter(
    (reference) => reference.resolution === 'discarded',
  );
  const byResolution: Record<Resolution, number> = {
    resolved: graph.byResolution.resolved.length,
    'resolved-pattern': graph.byResolution['resolved-pattern'].length,
    'out-of-scope': graph.byResolution['out-of-scope'].length,
    dynamic: graph.byResolution.dynamic.length,
    broken: graph.byResolution.broken.length,
    discarded: discardedReferences.length,
    'unresolved-alias': graph.byResolution['unresolved-alias'].length,
  };

  const byConfidence: Record<Confidence, number> = { certain: 0, high: 0, medium: 0, unsafe: 0 };
  for (const reference of references) byConfidence[reference.confidence] += 1;

  // Only a linked reference has a `resolvedVia`.
  const byResolvedVia: Record<ResolvedVia, number> = {
    file: 0,
    'serving-root': 0,
    'project-root': 0,
    'speculative-root': 0,
  };
  for (const reference of graph.references) {
    if (isLinked(reference)) byResolvedVia[reference.resolvedVia] += 1;
  }

  const byClassification: Record<ReferenceClass, number> = {
    'resolved-with-an-answer': 0,
    'missed-with-an-answer': 0,
    'correctly-refused': 0,
    'not-a-claim': 0,
  };
  for (const reference of references) byClassification[classifyReference(reference)] += 1;

  const boundCounts = new Map<string, number>();
  for (const reference of references) {
    const id = refusalReasonId(reference);
    if (id !== null) boundCounts.set(id, (boundCounts.get(id) ?? 0) + 1);
  }
  const classificationBounds: ClassificationBound[] = [];
  for (const reason of REFUSAL_REASONS) {
    const count = boundCounts.get(reason.id) ?? 0;
    if (count > 0 && reason.bound !== null) {
      classificationBounds.push({
        reason: reason.id,
        count,
        bound: reason.bound,
        // A bound with no recorded measurement says so, rather than printing nothing.
        measuredAgainst: reason.measuredAgainst ?? 'not recorded; treat this bound as unverified',
      });
    }
  }

  const { unsafe, leftOut } = unlinkedEntries(references, graph.root, aliases, leftOutReason);

  const discarded = includeDiscarded
    ? discardedReferences.map((reference) => ({
        file: relativePath(graph.root, reference.file),
        rawPath: reference.rawPath,
        resolution: reference.resolution,
        reason: reference.note ?? 'a path-shaped string that resolved to nothing',
        classification: classifyReference(reference),
        refusalReason: refusalReasonId(reference),
      }))
    : null;

  return {
    byResolution,
    byConfidence,
    byResolvedVia,
    byClassification,
    refusalAccuracyIsNotSelfAssessable: true,
    classificationBounds,
    unsafe,
    leftOut,
    discardedCount: byResolution.discarded,
    discarded,
    declinedValues: declinedValueReport(graph, includeDiscarded),
  };
}

/**
 * The `dynamic`, `unresolved-alias` and `out-of-scope` references, as entries: those the
 * project's own rules left out apart from the rest, each listed with its rule.
 */
function unlinkedEntries(
  references: readonly Reference[],
  root: string,
  aliases: AliasMap,
  leftOutReason: (reference: Reference) => string | null,
): { unsafe: ReferenceEntry[]; leftOut: ReferenceEntry[] } {
  const unsafe: ReferenceEntry[] = [];
  const leftOut: ReferenceEntry[] = [];
  for (const reference of references) {
    if (
      reference.resolution !== 'dynamic' &&
      reference.resolution !== 'unresolved-alias' &&
      reference.resolution !== 'out-of-scope'
    ) {
      continue;
    }
    const rule = leftOutReason(reference);
    (rule === null ? unsafe : leftOut).push({
      file: relativePath(root, reference.file),
      rawPath: reference.rawPath,
      resolution: reference.resolution,
      reason: rule ?? unlinkedReason(reference, aliases),
      classification: classifyReference(reference),
      refusalReason: refusalReasonId(reference),
    });
  }
  return { unsafe, leftOut };
}

/** Said of a reference to an image an ignore rule excluded by name. */
const LEFT_OUT_IMAGE = 'an ignore rule leaves this image out';

/**
 * The rule of the project's own that left out an `out-of-scope` reference's target, or null
 * when none did: a directory an ignore rule excluded, or an image one excluded by name. The
 * directories the walk prunes, such as `node_modules`, are not the project's rules.
 */
function leftOutBy(discovery: DiscoveryResult): (reference: Reference) => string | null {
  const byRule = discovery.excludedRoots.filter((root) => root.byRule);
  const images = new Set(discovery.excludedImages);
  return (reference) => {
    if (reference.resolution !== 'out-of-scope') return null;
    const target = toPosix(reference.resolvedPath);
    const root = byRule.find((excluded) => target.startsWith(`${toPosix(excluded.path)}/`));
    if (root !== undefined) return root.reason;
    return images.has(relativePath(discovery.root, reference.resolvedPath)) ? LEFT_OUT_IMAGE : null;
  };
}

/**
 * Why an unlinked reference is listed. An adapter's note describes the construct, such as
 * "static import", which says nothing about why an alias went unmapped.
 */
function unlinkedReason(reference: Reference, aliases: AliasMap): string {
  if (reference.resolution === 'out-of-scope') return reference.exclusionReason;
  if (reference.resolution === 'unresolved-alias') return aliasReason(reference, aliases);
  return reference.note ?? 'no static path to resolve';
}

/**
 * Why no alias Upfly reads maps a reference. A config whose aliases Upfly could not read may
 * hold the alias, so each one that covers the file is named, the nearest first. SvelteKit's
 * `$lib` also says what writes it, since a fresh clone has not run that yet.
 */
function aliasReason(reference: Reference, aliases: AliasMap): string {
  const reason = unmappedAliasReason(reference.file, aliases);
  const svelteKit = reference.rawPath === '$lib' || reference.rawPath.startsWith('$lib/');
  return svelteKit ? `${reason}. ${SVELTEKIT_WRITES_LIB}` : reason;
}

const SVELTEKIT_WRITES_LIB =
  'SvelteKit writes `$lib` into `.svelte-kit/tsconfig.json` when `svelte-kit sync` runs, as installing the project does, so run `npx svelte-kit sync`, or install the project, then run Upfly again';

function unmappedAliasReason(file: string, aliases: AliasMap): string {
  const from = toPosix(file);
  const depth = new Map<string, number>();
  for (const skip of aliases.skipped) {
    for (const scope of skip.scopes) {
      if (!from.startsWith(`${scope}/`)) continue;
      depth.set(skip.what, Math.max(depth.get(skip.what) ?? 0, scope.length));
    }
  }

  const [nearest, ...others] = [...depth]
    .sort(([a, aDepth], [b, bDepth]) => bDepth - aDepth || compareStrings(a, b))
    .map(([what]) => what);
  // What Upfly reads, not what the project declares: a webpack config or SvelteKit's
  // `kit.alias` can declare an alias that no config Upfly reads holds.
  if (nearest === undefined) {
    return "alias-shaped, and no alias Upfly reads maps it; it reads only tsconfig and jsconfig paths and a Vite config's resolve.alias";
  }
  const unread =
    others.length === 0 ? `${nearest} has` : `${nearest} and ${others.length} more have`;
  return `alias-shaped, and no alias Upfly could read maps it; ${unread} aliases Upfly could not read, listed under Skipped`;
}

/**
 * The values an adapter declined, counted by reason. The resolver keeps only those that name
 * an image, so each one here is a path a reader could mistake for a link.
 */
function declinedValueReport(graph: Graph, includeDiscarded: boolean): DeclinedValueReport {
  const declined = graph.byResolution.discarded.filter((reference) => reference.declined === true);
  const reasonOf = (reference: Reference): string =>
    reference.note ?? 'a value an adapter does not read as a file path';

  const counts = new Map<string, number>();
  for (const reference of declined) {
    counts.set(reasonOf(reference), (counts.get(reasonOf(reference)) ?? 0) + 1);
  }
  const byReason = [...counts]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || compareStrings(a.reason, b.reason));

  return {
    count: declined.length,
    byReason,
    values: includeDiscarded
      ? declined.map((reference) => ({
          file: relativePath(graph.root, reference.file),
          rawPath: reference.rawPath,
          reason: reasonOf(reference),
        }))
      : null,
  };
}

/**
 * The declined assets, sized from the graph. A declined path the graph does not know means
 * the planner and the graph disagree; it is reported with zero bytes rather than dropped.
 */
function declinedReport(input: ReportInput): DeclinedReport {
  const declined = (input.declined ?? []).filter(declinesAnImage);
  const sizeOf = new Map(input.graph.assets.map((node) => [node.asset.relative, node.asset.bytes]));

  const assets = declined.map((entry) => ({
    asset: entry.path,
    bytes: sizeOf.get(entry.path) ?? 0,
    reason: entry.reason,
  }));

  return {
    count: assets.length,
    bytes: assets.reduce((total, entry) => total + entry.bytes, 0),
    assets: input.includeDeclined ? assets : null,
  };
}

/** The references the plan left as written, with the planner's reasons. */
function declinedReferencesReport(input: ReportInput): DeclinedReferencesReport {
  const references = (input.declined ?? [])
    .filter((entry) => !declinesAnImage(entry))
    .map((entry) => ({ file: entry.path, line: entry.line, reason: entry.reason }));
  return { count: references.length, references: input.includeDeclined ? references : null };
}

/**
 * Whether a plan's decline is of an image rather than of a reference. A reference's decline
 * names the source file that holds it, which is never an image: an SVG is not scanned.
 */
function declinesAnImage(entry: Declined): boolean {
  return isImageExtension(extensionOf(entry.path));
}

function coverageReport(input: ReportInput): CoverageReport {
  return {
    unscannedExtensions: input.graph.unscannedExtensions,
    unscannedFileCount: input.graph.unscannedFiles.length,
    // `ExcludedRoot` also carries an absolute `path`, which must not reach the report.
    excludedRoots: input.discovery.excludedRoots.map((root) => ({
      path: root.relative,
      reason: root.reason,
    })),
    servingRoots: input.servingRoots,
    notExercised: notExercised(input),
  };
}

/**
 * What this run did not exercise. Each entry is a fact about what the caller supplied,
 * never a judgement about the engine, so the list cannot become a place for excuses.
 */
function notExercised(input: ReportInput): NotExercised[] {
  const entries: NotExercised[] = [];

  if (input.servingRoots.declared) {
    entries.push({
      mechanism: 'serving-root-detection',
      why: 'the project declared its serving roots, so nothing had to infer them; a run that infers them can reach different files',
    });
  }

  if (input.probes === undefined) {
    entries.push({
      mechanism: 'probe',
      why: 'the run did not measure any asset, so oversized and format-opportunity findings could not be produced',
    });
  }

  return entries;
}

/**
 * Probe outcomes that are conclusions rather than failures.
 *
 * Keyed on `ProbeSkipCode` rather than on the message, which is what that field is
 * for: a report that groups by prose breaks the moment somebody rewords a sentence.
 */
const DETERMINED_NOT_WORTH_MEASURING: ReadonlySet<ProbeSkipCode> = new Set([
  'vector',
  'already-target-format',
]);

/** Every skip from every stage, in one list, so there is a single place to append to. */
function collectSkips(input: ReportInput): SkippedItem[] {
  const items: SkippedItem[] = [];

  for (const entry of input.discovery.skipped) {
    items.push({
      what: entry.relative,
      stage: 'discovery',
      reason: `${entry.reason}: ${entry.detail}`,
    });
  }

  // A file no adapter claims is coverage, reported under `coverage`. A file an adapter
  // claimed and could not read is a failure, and belongs here.
  for (const file of input.graph.unscannedFiles) {
    if (file.reason === 'unclaimed-extension') continue;
    items.push({ what: file.relative, stage: 'scan', reason: `${file.reason}: ${file.detail}` });
  }

  for (const skip of input.sweep.skipped) {
    items.push({ what: skip.relative, stage: 'sweep', reason: skip.reason });
  }

  for (const skip of input.aliases.skipped) {
    items.push({ what: skip.what, stage: 'aliases', reason: skip.reason });
  }

  for (const source of input.audit.unreadableSources) {
    items.push({ what: source.relative, stage: 'citation', reason: source.reason });
  }

  for (const probe of input.probes ?? []) {
    for (const skip of probe.skipped) {
      // A vector, or an image already in the target format, is Upfly finding there is
      // nothing to gain, not a failure. These are counted in the `nothing-to-measure`
      // caveat instead.
      if (DETERMINED_NOT_WORTH_MEASURING.has(skip.code)) continue;
      items.push({
        what: probe.relative,
        stage: 'measurement',
        reason: `${skip.measurement}: ${skip.reason}`,
      });
    }
  }

  return items.sort(
    (a, b) =>
      compareStrings(a.stage, b.stage) ||
      compareStrings(a.what, b.what) ||
      compareStrings(a.reason, b.reason),
  );
}

/**
 * How many assets needed no measurement, and why, grouped by reason. An asset can be
 * skipped once per format, so the total counts assets and the breakdown counts
 * measurements.
 */
function countDeterminations(input: ReportInput): { total: number; detail: string[] } {
  const assets = new Set<string>();
  const byCode = new Map<ProbeSkipCode, number>();

  for (const probe of input.probes ?? []) {
    for (const skip of probe.skipped) {
      if (!DETERMINED_NOT_WORTH_MEASURING.has(skip.code)) continue;
      assets.add(probe.relative);
      byCode.set(skip.code, (byCode.get(skip.code) ?? 0) + 1);
    }
  }

  const label: Record<string, string> = {
    vector: 'vectors, where an encode would measure a rasterisation rather than a saving',
    'already-target-format': 'already in the format Upfly would convert to',
  };

  return {
    total: assets.size,
    // The label first and the count last, like the other detail lists, so the count
    // never has to agree with the label's grammar.
    detail: [...byCode]
      .sort((a, b) => b[1] - a[1] || compareStrings(a[0], b[0]))
      .map(([code, count]) => `${label[code] ?? code}: ${count}`),
  };
}

/** The limitations that apply to the whole run rather than to one finding. */
function caveats(
  input: ReportInput,
  vectors: { demoted: readonly UnusedVectorEntry[] },
  kept: readonly KeptOriginalEntry[],
): Caveat[] {
  const list: Caveat[] = [];

  // The demoted vectors reach the report here with the real reason, that there is no action
  // to offer, and not that vectors are small, which is often false. `not listed` is a
  // participle, so no verb has to agree with the count.
  if (vectors.demoted.length > 0) {
    const bytes = vectors.demoted.reduce((total, entry) => total + entry.bytes, 0);
    list.push({
      code: 'unused-vectors',
      count: vectors.demoted.length,
      message: `${plural(vectors.demoted.length, 'unreferenced SVG')} totalling ${formatBytes(bytes)}, not listed: Upfly neither converts an SVG nor deletes an asset, so there is no action to offer. Use --include-unused-svg to see them.`,
      detail: [],
    });
  }
  // Counted over the findings this report lists, leaving out the vectors and kept
  // originals moved out of `findings`, so every one counted is one listed.
  const demotedAssets = new Set([...vectors.demoted, ...kept].map((entry) => entry.asset));
  const deadInPublic = input.audit.findings.filter(
    (finding) =>
      finding.kind === 'dead' && finding.inPublicDir && !demotedAssets.has(finding.asset),
  ).length;

  if (deadInPublic > 0) {
    // A project served from its own root gets a different sentence: "under the public
    // directory" would mean the whole repository, and with no directory to exclude, the
    // reference graph cannot show that any unreferenced file is unreachable.
    const servesFromRoot = input.servingRoots.dirs.includes('');
    list.push({
      code: 'public-dir-dead',
      count: deadInPublic,
      message: servesFromRoot
        ? `this project is served from its own root, so ${plural(deadInPublic, 'unreferenced image')} may be linked from outside this repository, and Upfly cannot confidently call an unreferenced image here safe to remove`
        : `${plural(deadInPublic, 'unreferenced image')} under the public directory may be linked from outside this repository`,
      detail: [],
    });
  }

  // These assets have no reference and no finding, so without this line the headline's
  // count of images with no reference would exceed the `dead` and `possibly-dead`
  // findings with nothing in the report to explain the gap.
  const convention = input.audit.conventionLinked;
  if (convention.length > 0) {
    list.push({
      code: 'framework-conventions',
      count: convention.length,
      message: `${plural(convention.length, 'unreferenced image')} not reported dead, because a framework reads each one by its filename`,
      detail: convention.map((link) => `${link.asset}: ${link.reason}`),
    });
  }

  const determined = countDeterminations(input);
  if (determined.total > 0) {
    list.push({
      code: 'nothing-to-measure',
      count: determined.total,
      message: `${plural(determined.total, 'image')} needed no measurement`,
      detail: determined.detail,
    });
  }

  if (!input.audit.duplicatesChecked) {
    list.push({
      code: 'duplicates-not-checked',
      count: 0,
      message:
        'assets were not compared byte for byte, so identical copies are unknown; this run reports no duplicates because it looked for none',
      detail: [],
    });
  }

  if (!input.audit.probed) {
    list.push({
      code: 'not-probed',
      count: 0,
      message: 'images were not decoded, so oversized assets and format opportunities are unknown',
      detail: [],
    });
  }

  const capped = (input.probes ?? []).filter((probe) =>
    probe.skipped.some((skip) => skip.code === 'beyond-encode-cap'),
  ).length;
  if (capped > 0) {
    list.push({
      code: 'encode-capped',
      count: capped,
      message: `${plural(capped, 'image')} beyond the measurement cap ${were(capped)} not encoded; run with --probe-all to measure the rest`,
      detail: [],
    });
  }

  // Unread files make three caveats rather than one, because a reader acts on each group
  // differently. See `groupUnscanned`.
  // Only the files no adapter claimed: one an adapter could not parse is under skipped, and
  // counting it here would say the file type has no adapter.
  const groups = groupUnscanned(
    countExtensions(
      input.graph.unscannedFiles.filter((file) => file.reason === 'unclaimed-extension'),
    ),
  );

  // Said once per run rather than in every decline reason. Each image comes first with
  // where it is still named, which is what the user acts on. Then the check's limit: it
  // finds only paths that are written down, so without it a reader would take these
  // refusals as covering paths a program assembles at runtime too.
  const heldBack = (input.declined ?? [])
    .filter((entry) => entry.reason.includes(MENTION_SURVIVES))
    .sort((a, b) => compareStrings(a.path, b.path));
  if (heldBack.length > 0) {
    list.push({
      code: 'replace-held-back',
      count: heldBack.length,
      message: `${plural(heldBack.length, 'image')} kept rather than replaced, because a literal mention of the original's path would have outlived the rewrite`,
      detail: [
        ...heldBack.map((entry) => `${entry.path}: ${entry.reason}`),
        'This check reads text, so it finds a path that is written down. A path a program',
        "assembles at runtime, such as '/images/' + name + '.png', matches nothing, so",
        'replacing is safe here against literal mentions and no wider than that.',
      ],
    });
  }

  // What the project's own rules left out. Upfly never reads it, so an image only it uses is
  // reported as unreferenced. The directories the walk prunes are not listed: they hold no page
  // the project serves from its own sources, and naming them would fire on every run.
  const byRule = input.discovery.excludedRoots.filter((root) => root.byRule);
  const excluded = byRule.length + input.discovery.excludedFiles.length;
  if (excluded > 0) {
    list.push({
      code: 'excluded-roots',
      count: excluded,
      message: `Your ignore rules left out ${plural(excluded, 'path')}, which Upfly did not scan for references, so an image used only there can show as unreferenced`,
      detail: [
        ...byRule.map((root) => `${root.relative}/: ${root.reason}`),
        ...input.discovery.excludedFiles,
      ],
    });
  }

  if (groups.adapterCould.length > 0) {
    const files = groups.adapterCould.reduce((total, entry) => total + entry.fileCount, 0);
    list.push({
      code: 'unscanned-extensions',
      count: files,
      message: `${plural(groups.adapterCould.length, 'file type')} had no adapter, so ${plural(files, 'file')} went unread`,
      detail: groups.adapterCould.map(
        (entry) =>
          `${entry.ext === '' ? '(no extension)' : entry.ext}: ${plural(entry.fileCount, 'file')}`,
      ),
    });
  }

  if (groups.binary.length > 0) {
    const files = groups.binary.reduce((total, entry) => total + entry.fileCount, 0);
    list.push({
      code: 'binary-file-types',
      count: files,
      // An invariant subject, so no verb has to agree with the count.
      message: `binary formats have no text for an adapter to read, so no adapter ever will (${plural(files, 'file')} here)`,
      detail: groups.binary.map((entry) => `${entry.ext}: ${plural(entry.fileCount, 'file')}`),
    });
  }

  if (groups.svg > 0) {
    list.push({
      code: 'svg-both-ways',
      count: groups.svg,
      message: `SVG files are counted as images and also left unparsed: one can hold references of its own, and no adapter reads that yet (${plural(groups.svg, 'SVG')} here)`,
      detail: [],
    });
  }

  return list;
}

/** Verb agreement, so a report never says "1 file were not read". */
function were(value: number): string {
  return value === 1 ? 'was' : 'were';
}
