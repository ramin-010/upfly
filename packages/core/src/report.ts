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

import type { AuditResult, Finding } from './audit.js';
import type { Graph } from './graph.js';
import { compareStrings, relativePath } from './paths.js';
import type { AssetProbe } from './probe.js';
import type { SweepResult } from './sweep.js';
import type { Confidence, DiscoveryResult, Resolution, UnscannedExtension } from './types.js';

/**
 * Schema version of the JSON report.
 *
 * Bumped when a field changes meaning or disappears — never for an addition, since
 * a consumer that ignores unknown fields keeps working.
 */
export const REPORT_SCHEMA_VERSION = 1;

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
export interface UnsafeReferenceEntry {
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
  readonly unsafe: readonly UnsafeReferenceEntry[];
  /**
   * Speculative path-shaped strings that did not resolve.
   *
   * Counted rather than listed: a large repository produces thousands from
   * lockfiles and i18n bundles, and listing them would bury everything else. Not a
   * silent skip — the count is right here, and it is what tells a user the JSON
   * adapter has started eating something real.
   */
  readonly discardedCount: number;
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

/** A limitation that applies to the report as a whole rather than to one finding. */
export interface Caveat {
  readonly code:
    | 'public-dir-dead'
    | 'not-probed'
    | 'encode-capped'
    | 'excluded-roots'
    | 'unscanned-extensions';
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
  /** Every finding, in the audit's report order. */
  readonly findings: readonly Finding[];
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
}

/** Build the report. Pure, and the only place that decides what the public shape is. */
export function buildReport(input: ReportInput): Report {
  const findings = input.audit.findings;

  return {
    version: REPORT_SCHEMA_VERSION,
    summary: summarise(input, findings),
    findings,
    references: referenceReport(input.graph),
    coverage: coverageReport(input),
    skipped: collectSkips(input),
    caveats: caveats(input),
  };
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

function referenceReport(graph: Graph): ReferenceReport {
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

  const unsafe: UnsafeReferenceEntry[] = [];
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

  return { byResolution, byConfidence, unsafe, discardedCount: byResolution.discarded };
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

/** The limitations that apply to the whole run rather than to one finding. */
function caveats(input: ReportInput): Caveat[] {
  const list: Caveat[] = [];
  const deadInPublic = input.audit.publicDirDeadCount;

  if (deadInPublic > 0) {
    list.push({
      code: 'public-dir-dead',
      count: deadInPublic,
      message: `${plural(deadInPublic, 'unreferenced image')} under the public directory may be linked from outside this repository`,
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
      message: `${plural(capped, 'image')} beyond the measurement cap ${were(capped)} not encoded, so the savings there are unknown`,
      detail: [],
    });
  }

  const unscanned = input.graph.unscannedExtensions;
  if (unscanned.length > 0) {
    list.push({
      code: 'unscanned-extensions',
      count: input.graph.unscannedFiles.length,
      message: `${plural(unscanned.length, 'file type')} had no adapter, so ${plural(input.graph.unscannedFiles.length, 'file')} went unread`,
      // Naming them is the point: this is how a user discovers which adapter they
      // want, and it is the difference between a shrug and a next step.
      detail: unscanned.map(
        (entry) => `${entry.ext || '(no extension)'} — ${plural(entry.fileCount, 'file')}`,
      ),
    });
  }

  if (input.discovery.excludedRoots.length > 0) {
    list.push({
      code: 'excluded-roots',
      count: input.discovery.excludedRoots.length,
      message: `${plural(input.discovery.excludedRoots.length, 'directory', 'directories')} ${were(input.discovery.excludedRoots.length)} not entered, so nothing inside ${input.discovery.excludedRoots.length === 1 ? 'it' : 'them'} was read`,
      detail: input.discovery.excludedRoots.map((root) => `${root.relative} — ${root.reason}`),
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
