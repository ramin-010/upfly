/**
 * Assemble everything the pipeline learned into the shape people and agents read.
 *
 * The JSON is **public API** (rule 6): versioned, snapshot-tested, and changed only
 * deliberately. An agent reading `upfly audit --json` is as much a consumer as a
 * person reading the terminal, and it is the one that cannot ask what a field meant.
 *
 * Three properties this module exists to guarantee:
 *
 * **No absolute path ever reaches the output.** §5.1(f) runs the same repository
 * from two working directories and requires byte-identical JSON, and half the data
 * upstream carries both an absolute `path` and a POSIX `relative` — `SkippedEntry`,
 * `ExcludedRoot`, `UnscannedFile`, `Reference.file`. Projecting to the relative form
 * is this module's job, and there is a test that greps the serialised report for the
 * root.
 *
 * **Deterministic** (rule 11): every list sorted, no timestamps, no durations, and
 * no locale-dependent formatting anywhere near a number.
 *
 * **Nothing is dropped.** Every skip from every stage lands in one flat `skipped`
 * list. Rule 9 says a silent skip is a P0 bug, and a single list is much harder to
 * forget to append to than five per-stage ones.
 */

import type { AuditResult, DeadFinding, Finding, PossiblyDeadFinding } from './audit.js';
import { formatBytes } from './format.js';
import type { Graph } from './graph.js';
import {
  compareStrings,
  extensionOf,
  isImageExtension,
  isVectorExtension,
  relativePath,
} from './paths.js';
import type { AssetProbe, ProbeSkipCode } from './probe.js';
import type { Mention, SweepResult } from './sweep.js';
import type { Confidence, DiscoveryResult, Resolution, UnscannedExtension } from './types.js';

/**
 * Schema version of the JSON report.
 *
 * Bumped when a field changes meaning or disappears — never for an addition, since
 * a consumer that ignores unknown fields keeps working.
 *
 * **2 — R22.** `findings` no longer holds every finding the audit produced: an
 * unreferenced vector nothing can act on is demoted to `unusedVectors`, and
 * `summary.findings` counts the itemised set so the two can never disagree. That is a
 * change of meaning in the array a consumer is most likely to read, so it earns the
 * bump even though `unusedVectors` and `staleConversions` are themselves additions.
 * The alternative — leaving the vectors in place and flagging them — would have kept
 * the version at 1 by making an agent and a person disagree about the same run.
 */
export const REPORT_SCHEMA_VERSION = 2;

/** The numbers people screenshot. */
export interface ReportSummary {
  readonly assets: number;
  readonly assetBytes: number;
  readonly sourceFiles: number;
  readonly references: number;
  /** References that point at an asset — via `isLinked`, so patterns count. */
  readonly linkedReferences: number;
  /** Assets with at least one reference. */
  readonly referencedAssets: number;
  readonly findings: Readonly<Record<Finding['kind'], number>>;
  /**
   * Best measured saving per asset, summed.
   *
   * The best, not the total: an asset measured against both webp and avif would
   * otherwise be counted twice and the headline number would be a fiction.
   */
  readonly potentialSavingBytes: number;
  /** `false` when the run was `--no-probe`; oversized and opportunities are absent. */
  readonly probed: boolean;
}

/** One reference the engine declined to link, listed rather than merely counted. */
export interface ReferenceEntry {
  /** POSIX-relative source file. */
  readonly file: string;
  readonly rawPath: string;
  readonly resolution: Resolution;
  /** The adapter's note, or the exclusion rule — whichever explains this one. */
  readonly reason: string;
}

export interface ReferenceReport {
  readonly byResolution: Readonly<Record<Resolution, number>>;
  readonly byConfidence: Readonly<Record<Confidence, number>>;
  /**
   * The "I could not be sure" bucket, in full: `dynamic`, `unresolved-alias` and
   * `out-of-scope`.
   *
   * Listed because this is the honesty that earns trust for the rest of the
   * report — it is exactly the set surfaced as "N references I couldn't safely
   * rewrite". `broken` is not here: it is a finding, with a line number.
   */
  readonly unsafe: readonly ReferenceEntry[];
  /**
   * Speculative path-shaped strings that did not resolve.
   *
   * Counted rather than listed by default: a large repository produces thousands
   * from lockfiles and i18n bundles, and listing them would bury everything else.
   */
  readonly discardedCount: number;
  /**
   * The discarded candidates themselves, when `includeDiscarded` asked for them.
   *
   * `null` — not `[]` — when they were not requested, because an empty array would
   * read as "there were none", which is the same class of lie as silence reading
   * as "no opportunity here".
   *
   * The list has to be reachable for a specific reason: the JSON adapter is
   * deliberately generous, so if it ever starts eating genuine references the
   * count tells you something is wrong while only the list tells you *what*. You
   * cannot debug that from an integer, and §1.1 promises these are inspectable.
   */
  readonly discarded: readonly ReferenceEntry[] | null;
}

/** What the engine did not read, and what it refused to enter. */
export interface CoverageReport {
  readonly unscannedExtensions: readonly UnscannedExtension[];
  readonly unscannedFileCount: number;
  readonly excludedRoots: readonly { readonly path: string; readonly reason: string }[];
}

/** Where a skip happened, so a reader can tell a parse failure from a bad symlink. */
export type SkipStage = 'discovery' | 'scan' | 'sweep' | 'citation' | 'measurement';

/** One thing the engine declined to do. Rule 9's home in the report. */
export interface SkippedItem {
  /** POSIX-relative path of the file or asset involved. */
  readonly what: string;
  readonly stage: SkipStage;
  readonly reason: string;
}

/**
 * One unreferenced vector, as it appears behind the flag.
 *
 * A union rather than an optional `evidence`, mirroring the invariant
 * `PossiblyDeadFinding` already holds: no evidence means `dead`, so a hedge without its
 * citation is unrepresentable rather than merely discouraged.
 *
 * ⚠️ **It carries everything the finding carried, and that is load-bearing rather than
 * tidy.** §5.1(d)'s independent oracle walks `report.findings`, so the first version of
 * R22 silently removed 145 assets from the verification pass — astro-docs' verdict count
 * fell from 150 to 24 — and "0 confirmed-false" would have been quoted over a denominator
 * that had shrunk by 70% with nothing saying so. Demoting a finding from the default
 * report must not demote it out of being checked.
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
 * R22: unreferenced vectors, counted rather than itemised.
 *
 * **The argument is that we offer no action, not that vectors are small** — that
 * second claim was measured and is false: SVG is 96% of `shadcn-ui`'s hedged bytes.
 * We already decline to encode a vector (`VECTOR_EXTENSIONS`) and §8 decision 7 says
 * Upfly never deletes an asset, so itemising an unused one proposes the only two
 * things we will not do. On `astro-docs` this is 126 of 150 unreferenced-asset
 * findings, which is why the list was unreadable rather than merely long.
 *
 * Rule 9 is satisfied by `count` — nothing is silently dropped. `bytes` is here
 * because §8 decision 7 leaves the reader holding the decision, and a total is what
 * turns a list into one: `eleventy-docs`'s nine vectors are 210 KB, and nine
 * filenames would not have said that.
 */
export interface UnusedVectorReport {
  readonly count: number;
  /** Their total size, which is the fact that makes the count actionable. */
  readonly bytes: number;
  /**
   * The vectors themselves, when `includeUnusedVectors` asked for them.
   *
   * `null` — not `[]` — when they were not requested, for the same reason
   * `ReferenceReport.discarded` is: an empty array reads as "there were none", which
   * is the same class of lie as silence reading as "no opportunity here".
   */
  readonly assets: readonly UnusedVectorEntry[] | null;
}

/**
 * R23: an unreferenced vector standing beside a broken reference to its raster twin.
 *
 * Both halves are already findings on their own. Said together they mean *"you
 * converted this by hand and forgot the reference"*, which neither says alone — and
 * it is the one case where an unused vector **does** have an action, so these stay
 * itemised in `findings` rather than being demoted by R22.
 *
 * ⚠️ Deliberately **not** phrased as a conclusion. The pairing is two facts and their
 * proximity; the reader decides whether it is a forgotten conversion or a
 * coincidence of naming. R15's rule — a weak resolution must not drive an action —
 * applies to sentences as much as to rewrites.
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
    | 'encode-capped'
    | 'excluded-roots'
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
   * "no adapter reads these file types" is a shrug; naming `.njk (2 files)` is how
   * a user finds out which adapter they want.
   */
  readonly detail: readonly string[];
}

export interface Report {
  readonly version: number;
  readonly summary: ReportSummary;
  /**
   * Every finding there is something to do about, in the audit's report order.
   *
   * ⚠️ **Not every finding the audit produced** (R22, schema 2). An unreferenced
   * vector is in `unusedVectors` instead — unless it pairs with a broken reference to
   * its raster twin, which gives it an action and keeps it here. `summary.findings`
   * counts this array, so the two always agree.
   */
  readonly findings: readonly Finding[];
  /** R22: the unreferenced vectors this report declines to itemise, and their size. */
  readonly unusedVectors: UnusedVectorReport;
  /** R23: unreferenced vectors beside a broken reference to their raster twin. */
  readonly staleConversions: readonly StaleConversion[];
  readonly references: ReferenceReport;
  readonly coverage: CoverageReport;
  /** Everything declined, from every stage, sorted. */
  readonly skipped: readonly SkippedItem[];
  readonly caveats: readonly Caveat[];
}

export interface ReportInput {
  readonly graph: Graph;
  readonly audit: AuditResult;
  /** For the entries only discovery saw: symlinks, unreadable files, pruned roots. */
  readonly discovery: DiscoveryResult;
  readonly sweep: SweepResult;
  /** Absent for a `--no-probe` run. */
  readonly probes?: readonly AssetProbe[];
  /**
   * Include the discarded candidates in full. Off by default (`--include-discarded`).
   *
   * Off because the list is usually thousands of lockfile strings; available
   * because a count alone cannot tell you *which* reference the JSON adapter
   * started eating.
   */
  readonly includeDiscarded?: boolean;
  /**
   * Itemise the unreferenced vectors R22 demotes. Off by default
   * (`--include-unused-svg`).
   *
   * Off because on `astro-docs` they are 126 of 150 unreferenced-asset findings and
   * there is no action to offer for any of them; available because a reader who wants
   * to audit our judgement should not have to take the count on trust.
   */
  readonly includeUnusedVectors?: boolean;
}

/** Build the report. Pure, and the only place that decides what the public shape is. */
export function buildReport(input: ReportInput): Report {
  const vectors = partitionUnusedVectors(input.audit.findings);

  return {
    version: REPORT_SCHEMA_VERSION,
    // The itemised set, not `audit.findings`: the summary counts what the report
    // shows, so a reader can never add up the findings and get a different number
    // from the one in the headline.
    summary: summarise(input, vectors.itemised),
    findings: vectors.itemised,
    unusedVectors: {
      count: vectors.demoted.length,
      bytes: vectors.demoted.reduce((total, entry) => total + entry.bytes, 0),
      assets: input.includeUnusedVectors ? vectors.demoted : null,
    },
    staleConversions: vectors.staleConversions,
    references: referenceReport(input.graph, input.includeDiscarded ?? false),
    coverage: coverageReport(input),
    skipped: collectSkips(input),
    caveats: caveats(input, vectors),
  };
}

/** The last path segment, tolerating either separator — a raw path is as written. */
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

/**
 * R22 and R23 in one pass, because they partition the same set.
 *
 * Order matters and is the whole design: R23's pairs are found **first**, and a paired
 * vector stays itemised. Demoting first and pairing afterwards would need the demoted
 * list back again, and the version of this that ran R22 alone would have hidden
 * exactly the 'you forgot the reference' cases R23 exists to surface.
 *
 * The audit still emits every finding (`audit.findings` is unchanged) — the graph's
 * account of what is unreferenced is not what R22 disputes. What the report decides is
 * which of them it can offer a reader an action for.
 */
/** Whether this finding is an unreferenced vector — the set R22 partitions. */
function isUnusedVector(finding: Finding): finding is DeadFinding | PossiblyDeadFinding {
  return (
    (finding.kind === 'dead' || finding.kind === 'possibly-dead') &&
    isVectorExtension(extensionOf(finding.asset))
  );
}

/** One broken reference, reduced to what R23 needs to say about it. */
interface BrokenRaster {
  readonly rawPath: string;
  readonly where: string;
}

/**
 * Broken references to a *raster*, indexed by filename stem.
 *
 * ⚠️ **Vectors are excluded, and that exclusion is the whole guard.** A broken reference
 * to another vector says nothing about a conversion: all 20 of `shadcn-ui`'s broken
 * references are `/next.svg`, `/vercel.svg` and `/vite.svg` from framework scaffolds, and
 * pairing those against its 10 unreferenced vectors would have invented ten conversion
 * stories out of matching filenames.
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

/** R23: the pairs, and the vectors they rescue from R22's demotion. */
function findStaleConversions(findings: readonly Finding[]): {
  staleConversions: readonly StaleConversion[];
  paired: ReadonlySet<string>;
} {
  const byStem = brokenRasterStems(findings);
  const staleConversions: StaleConversion[] = [];
  const paired = new Set<string>();

  for (const finding of findings) {
    if (!isUnusedVector(finding)) continue;
    // Exact and case-sensitive. `Hero.png` is a different file from `hero.png` on the
    // platform most of this runs on, and a hint nobody asked for costs more trust than
    // one we declined to offer.
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

function summarise(input: ReportInput, findings: readonly Finding[]): ReportSummary {
  const counts: Record<Finding['kind'], number> = {
    broken: 0,
    dead: 0,
    'possibly-dead': 0,
    oversized: 0,
    'format-opportunity': 0,
  };
  for (const finding of findings) counts[finding.kind] += 1;

  // Best per asset, not the sum of every measurement: an asset measured against
  // both webp and avif would otherwise be counted twice.
  const bestSaving = new Map<string, number>();
  for (const finding of findings) {
    if (finding.kind !== 'format-opportunity') continue;
    bestSaving.set(finding.asset, Math.max(bestSaving.get(finding.asset) ?? 0, finding.savedBytes));
  }

  return {
    assets: input.graph.assets.length,
    assetBytes: input.graph.assets.reduce((total, node) => total + node.asset.bytes, 0),
    sourceFiles: input.discovery.sourceFiles.length,
    references: input.graph.references.length,
    linkedReferences:
      input.graph.byResolution.resolved.length +
      input.graph.byResolution['resolved-pattern'].length,
    referencedAssets: input.graph.assets.filter((node) => node.references.length > 0).length,
    findings: counts,
    potentialSavingBytes: [...bestSaving.values()].reduce((total, bytes) => total + bytes, 0),
    probed: input.audit.probed,
  };
}

function referenceReport(graph: Graph, includeDiscarded: boolean): ReferenceReport {
  const byResolution: Record<Resolution, number> = {
    resolved: graph.byResolution.resolved.length,
    'resolved-pattern': graph.byResolution['resolved-pattern'].length,
    'out-of-scope': graph.byResolution['out-of-scope'].length,
    dynamic: graph.byResolution.dynamic.length,
    broken: graph.byResolution.broken.length,
    discarded: graph.byResolution.discarded.length,
    'unresolved-alias': graph.byResolution['unresolved-alias'].length,
  };

  const byConfidence: Record<Confidence, number> = { certain: 0, high: 0, medium: 0, unsafe: 0 };
  for (const reference of graph.references) byConfidence[reference.confidence] += 1;

  const unsafe: ReferenceEntry[] = [];
  for (const reference of graph.references) {
    if (
      reference.resolution !== 'dynamic' &&
      reference.resolution !== 'unresolved-alias' &&
      reference.resolution !== 'out-of-scope'
    ) {
      continue;
    }
    unsafe.push({
      file: relativePath(graph.root, reference.file),
      rawPath: reference.rawPath,
      resolution: reference.resolution,
      reason:
        reference.resolution === 'out-of-scope'
          ? reference.exclusionReason
          : (reference.note ?? defaultReason(reference.resolution)),
    });
  }

  const discarded = includeDiscarded
    ? graph.byResolution.discarded.map((reference) => ({
        file: relativePath(graph.root, reference.file),
        rawPath: reference.rawPath,
        resolution: reference.resolution,
        reason: reference.note ?? 'a path-shaped string that resolved to nothing',
      }))
    : null;

  return { byResolution, byConfidence, unsafe, discardedCount: byResolution.discarded, discarded };
}

function defaultReason(resolution: 'dynamic' | 'unresolved-alias'): string {
  return resolution === 'dynamic'
    ? 'no static path to resolve'
    : 'alias-shaped; alias resolution arrives in Phase 2';
}

function coverageReport(input: ReportInput): CoverageReport {
  return {
    unscannedExtensions: input.graph.unscannedExtensions,
    unscannedFileCount: input.graph.unscannedFiles.length,
    // Projected to `relative`: `ExcludedRoot` also carries an absolute `path`, and
    // letting that through is precisely the leak §5.1(f) tests for.
    excludedRoots: input.discovery.excludedRoots.map((root) => ({
      path: root.relative,
      reason: root.reason,
    })),
  };
}

/**
 * Every skip from every stage, in one list.
 *
 * One list rather than five, because rule 9 is easier to keep when there is a single
 * place to append to — and because the human renderer prints this *first*, which
 * only works if it is one thing to print.
 */
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

function collectSkips(input: ReportInput): SkippedItem[] {
  const items: SkippedItem[] = [];

  for (const entry of input.discovery.skipped) {
    items.push({
      what: entry.relative,
      stage: 'discovery',
      reason: `${entry.reason}: ${entry.detail}`,
    });
  }

  // Unclaimed extensions are coverage, not failure — they belong in `coverage`.
  // A file an adapter claimed and could not read is a failure, and belongs here.
  for (const file of input.graph.unscannedFiles) {
    if (file.reason === 'unclaimed-extension') continue;
    items.push({ what: file.relative, stage: 'scan', reason: `${file.reason}: ${file.detail}` });
  }

  for (const skip of input.sweep.skipped) {
    items.push({ what: skip.relative, stage: 'sweep', reason: skip.reason });
  }

  for (const source of input.audit.unreadableSources) {
    items.push({ what: source.relative, stage: 'citation', reason: source.reason });
  }

  for (const probe of input.probes ?? []) {
    for (const skip of probe.skipped) {
      // A determination is not a failure (R21). `vector` and
      // `already-target-format` are Upfly working out that there is nothing to gain
      // and saying so — filing them here made `140 things Upfly could not handle`
      // false for 134 of the 140 on `astro-docs`, and repeated one sentence 126
      // times. They are counted in a caveat instead; the per-asset detail is
      // untouched in the JSON, so rule 9 holds and nothing is hidden.
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
 * How many assets needed no measurement, and why, grouped by reason.
 *
 * One asset can contribute two entries — an SVG measured against both webp and avif
 * — so assets are counted once and the per-reason breakdown counts measurements.
 * The headline is the number of *images*, which is what a reader is counting.
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
    // `thing — count`, matching the other detail lists, rather than `count thing`
    // which rendered as "126 a vector". It is also the shape that cannot disagree
    // with itself at one.
    detail: [...byCode]
      .sort((a, b) => b[1] - a[1] || compareStrings(a[0], b[0]))
      .map(([code, count]) => `${label[code] ?? code} — ${count}`),
  };
}

/**
 * Unscanned extensions, split by what a reader can do about each.
 *
 * The distinction is not cosmetic: an adapter closes the first group, nothing closes
 * the second, and the third is a deliberate design decision rather than a gap.
 */
function groupUnscanned(extensions: readonly UnscannedExtension[]): {
  adapterCould: UnscannedExtension[];
  binary: UnscannedExtension[];
  svg: number;
} {
  const adapterCould: UnscannedExtension[] = [];
  const binary: UnscannedExtension[] = [];
  let svg = 0;

  for (const entry of extensions) {
    if (entry.ext === '.svg') svg += entry.fileCount;
    else if (BINARY_EXTENSIONS.has(entry.ext)) binary.push(entry);
    else adapterCould.push(entry);
  }

  return { adapterCould, binary, svg };
}

/**
 * Extensions whose contents are not text.
 *
 * Deliberately a list rather than a heuristic: guessing wrong in the *other*
 * direction would tell a user that a format no adapter reads is unreadable in
 * principle, which is exactly the kind of confident-and-wrong sentence R21 was
 * raised about. Anything not named here is assumed to be text an adapter could one
 * day read.
 */
const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  '.mp4',
  '.webm',
  '.mov',
  '.avi',
  '.mp3',
  '.wav',
  '.ogg',
  '.otf',
  '.ttf',
  '.woff',
  '.woff2',
  '.eot',
  '.ico',
  '.pdf',
  '.zip',
  '.gz',
  '.tar',
  '.wasm',
  '.node',
  '.bin',
  '.psd',
  '.sketch',
  '.db',
  '.sqlite',
]);

/** The limitations that apply to the whole run rather than to one finding. */
function caveats(input: ReportInput, vectors: { demoted: readonly UnusedVectorEntry[] }): Caveat[] {
  const list: Caveat[] = [];

  // R22. Rule 9 lives here: the demoted vectors are declined, so they reach the
  // report with a reason. The reason is the honest one — there is no action we would
  // offer — and not "they are small", which is measurably false.
  //
  // ⚠️ `not listed` is a participle, not a finite verb, and that is deliberate. The
  // first draft of this line read `${plural(n, 'unreferenced vector')} ... are not
  // listed`, which says "1 unreferenced vector are not listed" — the fifth instance
  // of that bug in this file, written directly underneath a comment about avoiding
  // it. There is nothing here for the count to disagree with now, and
  // "there is no action to offer" has an invariant subject.
  if (vectors.demoted.length > 0) {
    const bytes = vectors.demoted.reduce((total, entry) => total + entry.bytes, 0);
    list.push({
      code: 'unused-vectors',
      count: vectors.demoted.length,
      message: `${plural(vectors.demoted.length, 'unreferenced vector')} totalling ${formatBytes(bytes)}, not listed — Upfly neither converts a vector nor deletes an asset, so there is no action to offer. Use --include-unused-svg to see them.`,
      detail: [],
    });
  }
  const deadInPublic = input.audit.publicDirDeadCount;

  if (deadInPublic > 0) {
    list.push({
      code: 'public-dir-dead',
      count: deadInPublic,
      message: `${plural(deadInPublic, 'unreferenced image')} under the public directory may be linked from outside this repository`,
      detail: [],
    });
  }

  // R17. This line is load-bearing arithmetic, not a footnote: these assets have
  // zero references and produce no finding, so without it the headline's "N not
  // referenced" exceeds the dead and possibly-dead findings by an amount nothing
  // in the report explains. Naming the convention is the difference between a
  // reader trusting the gap and hunting for the bug.
  const convention = input.audit.conventionLinked;
  if (convention.length > 0) {
    list.push({
      code: 'framework-conventions',
      count: convention.length,
      message: `${plural(convention.length, 'unreferenced image')} are read by a framework from the filename, so they are not reported dead`,
      detail: convention.map((link) => `${link.asset} — ${link.reason}`),
    });
  }

  // R21: the count of things Upfly decided were not worth measuring, as one line
  // rather than 134. `astro-docs` is 126 vectors and 8 files already in the target
  // format — every one a successful determination, and the reader's question was
  // exactly right: *"if you can identify that, doesn't that count?"*
  const determined = countDeterminations(input);
  if (determined.total > 0) {
    list.push({
      code: 'nothing-to-measure',
      count: determined.total,
      message: `${plural(determined.total, 'image')} needed no measurement`,
      detail: determined.detail,
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
      message: `${plural(capped, 'image')} beyond the measurement cap ${were(capped)} not encoded — run with --probe-all to measure the rest`,
      detail: [],
    });
  }

  // R21: three different things were sharing one sentence, and only one of them is
  // a gap anybody can close.
  //
  //   `.astro` (82 files) is a real coverage gap — an adapter would read it.
  //   `.mp4`, `.otf`, `.ttf`, `.ico` are **binary**. There is nothing to read and no
  //   adapter will ever change that, so listing them as something we failed to do is
  //   the same error as filing a vector under "could not handle".
  //   `.svg` is a third case entirely: it is tracked as an image asset *and* can
  //   itself hold references (`<image href>`), so it is deliberately in both places.
  //
  // Splitting them is what turns a list into three statements a reader can act on
  // differently. The counts still add up to the same total.
  const groups = groupUnscanned(input.graph.unscannedExtensions);

  if (groups.adapterCould.length > 0) {
    const files = groups.adapterCould.reduce((total, entry) => total + entry.fileCount, 0);
    list.push({
      code: 'unscanned-extensions',
      count: files,
      message: `${plural(groups.adapterCould.length, 'file type')} had no adapter, so ${plural(files, 'file')} went unread`,
      // Naming them is the point: this is how a user discovers which adapter they
      // want, and it is the difference between a shrug and a next step.
      detail: groups.adapterCould.map(
        (entry) =>
          `${entry.ext === '' ? '(no extension)' : entry.ext} — ${plural(entry.fileCount, 'file')}`,
      ),
    });
  }

  if (groups.binary.length > 0) {
    const files = groups.binary.reduce((total, entry) => total + entry.fileCount, 0);
    list.push({
      code: 'binary-file-types',
      count: files,
      // Invariant subject, so the count cannot disagree with the verb. Written as
      // `${plural(files,'file')} are binary…` first, which reads "1 file are
      // binary" — the third instance of that bug in this file, committed an hour
      // after writing the note about avoiding it. A construction that cannot carry
      // it beats remembering to check.
      message: `binary formats have no text for an adapter to read, so no adapter ever will (${plural(files, 'file')} here)`,
      detail: groups.binary.map((entry) => `${entry.ext} — ${plural(entry.fileCount, 'file')}`),
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

/** `1 file` / `2 files`. English only, and deliberately not locale-aware. */
function plural(value: number, noun: string, plural_?: string): string {
  return `${value} ${value === 1 ? noun : (plural_ ?? `${noun}s`)}`;
}
