/**
 * Turn the graph, the probe and the sweep into findings.
 *
 * Four kinds, and they cost wildly different amounts to produce — which is the
 * design constraint, not an incidental fact:
 *
 * | finding | needs |
 * |---|---|
 * | `dead` / `possibly-dead` | the graph, plus the sweep for the hedge |
 * | `broken` | the graph alone |
 * | `oversized` | one header read per asset, ~1 ms |
 * | `format-opportunity` | a real encode, up to seconds per asset |
 *
 * Only the last is expensive, so only the last degrades when the probe is capped or
 * absent. That is what makes `--no-probe` and a low `maxEncodedAssets` safe rather
 * than merely fast: a user who turns them down still gets three complete findings
 * out of four.
 *
 * Pure, over the data those stages produced plus a `readFile` port — the same shape
 * as `scan`'s. The port is only ever used to turn an offset into a line, and only
 * for references that are already going into the report.
 */

import { citeReferences } from './citation.js';
import type { ConventionLink, ConventionRoot } from './conventions.js';
import { conventionLinkFor } from './conventions.js';
import { findDuplicates } from './duplicates.js';
import type { Graph } from './graph.js';
import { unreferencedAssets } from './graph.js';
import { compareStrings } from './paths.js';
import type { AssetProbe, EncodeFormat } from './probe.js';
import { type ResolutionHealth, resolutionHealth } from './resolution-health.js';
import type { ReadFilePort } from './scan.js';
import type { Mention, SweepResult } from './sweep.js';

/** An asset nothing references, and nothing we could not read mentions either. */
export interface DeadFinding {
  readonly kind: 'dead';
  /** POSIX-relative path. */
  readonly asset: string;
  readonly bytes: number;
  /**
   * Whether it sits under the public directory.
   *
   * Not a hedge — see `AuditResult.publicDirDeadCount`. A public asset may be
   * referenced from outside the repository entirely, but that is a bare
   * possibility with no evidence behind it, and hedging on bare possibility is
   * how the first version of the `possibly-dead` rule degenerated into a label
   * that fired on everything. The report carries one caveat line instead.
   */
  readonly inPublicDir: boolean;
}

/** An asset nothing references, but something we could not read mentions by name. */
export interface PossiblyDeadFinding {
  readonly kind: 'possibly-dead';
  readonly asset: string;
  readonly bytes: number;
  readonly inPublicDir: boolean;
  /** Why it is hedged. Non-empty by construction — no evidence means `dead`. */
  readonly evidence: readonly [Mention, ...Mention[]];
}

/** A path the author asserted was an asset, pointing at nothing. */
export interface BrokenFinding {
  readonly kind: 'broken';
  /** POSIX-relative path of the source file. */
  readonly file: string;
  /** One-based line, or `null` if the file could not be re-read. */
  readonly line: number | null;
  /** `file:line` — what §5.1(d)'s adversarial review opens. */
  readonly where: string;
  /** The path exactly as written. */
  readonly rawPath: string;
}

/** Which limit an asset exceeded. */
export type OversizeDimension = 'bytes' | 'width' | 'height';

export interface OversizedFinding {
  readonly kind: 'oversized';
  readonly asset: string;
  readonly bytes: number;
  readonly width: number | null;
  readonly height: number | null;
  /** Every limit exceeded, sorted. Never empty. */
  readonly exceeded: readonly [OversizeDimension, ...OversizeDimension[]];
}

/** A measured saving, never an estimated one. */
export interface FormatOpportunityFinding {
  readonly kind: 'format-opportunity';
  readonly asset: string;
  /** Source format as the decoder reported it, not as the extension claimed. */
  readonly from: string;
  readonly to: EncodeFormat;
  readonly bytes: number;
  /** What the encode actually produced, in memory. */
  readonly wouldBe: number;
  readonly savedBytes: number;
  /** Whole percent, floored — a report number, not a float to compare against. */
  readonly savedPercent: number;
  /**
   * The encode quality this saving was measured at.
   *
   * A saving without it is not a figure: the same image gives 95% at quality 50 and
   * 44% at quality 90, and those describe two different products. Carried from the
   * measurement rather than looked up, so the number and its setting cannot come
   * apart on the way to the report.
   */
  readonly quality: number;
}

/**
 * The engine could not work out where this project serves files from.
 *
 * It replaces the `broken` findings of the same run rather than joining them. When
 * almost no root-relative reference resolves, those are not broken references: they
 * are one misconfiguration seen N times, and reporting them individually states a
 * symptom as a diagnosis. Measured on eleventy-docs, that is 14 `broken` findings
 * whose targets are all present on disk.
 *
 * `suppressedBroken` is what keeps rule 9: the count of what this replaced is part of
 * the finding, and every one of those references is still itemised in the report's
 * own `references` section, so nothing is hidden, only re-explained.
 */
export interface ServingRootUnknownFinding {
  readonly kind: 'serving-root-unknown';
  /** Root-relative references that did resolve. */
  readonly linked: number;
  /** Root-relative references the engine could check: linked plus broken. */
  readonly checkable: number;
  /** How many `broken` findings this replaced. */
  readonly suppressedBroken: number;
}

export type Finding =
  | DeadFinding
  | PossiblyDeadFinding
  | BrokenFinding
  | ServingRootUnknownFinding
  | OversizedFinding
  | FormatOpportunityFinding
  | DuplicateFinding;

/**
 * Two or more assets shipping the same pixels (§1.1, approved 2026-09-11).
 *
 * 🔴 **Set-scoped, not asset-scoped, and that is not a shortcut.** Every other finding
 * names one asset because the fault is that asset's. A duplicate is a fault of the
 * *relationship* — no single copy is wrong, and saying `hero.png` is a duplicate
 * without naming what it duplicates is not something a reader can act on.
 *
 * ⚠️ It names no winner. Which copy should survive is a question about intent — one
 * may be a deliberate fallback, or referenced by something the graph cannot see — and
 * §8 decision 7 settles that we never pick and never delete.
 */
export interface DuplicateFinding {
  readonly kind: 'duplicate';
  /** Every asset with these bytes, in path order. At least two. */
  readonly assets: readonly string[];
  /** The size of one copy. */
  readonly bytes: number;
  /** What keeping one copy would recover: `bytes × (copies − 1)`. */
  readonly wastedBytes: number;
}

export interface AuditThresholds {
  /** Bytes above which an asset is oversized. Defaults to 500 000. */
  readonly maxBytes?: number;
  /** Pixels. Defaults to 4 000 — beyond any sensible display width. */
  readonly maxWidth?: number;
  /** Pixels. Defaults to 4 000. */
  readonly maxHeight?: number;
  /**
   * Absolute floor: nothing smaller than this is ever reported. Defaults to 1 KiB.
   *
   * A 40% saving on a 200-byte icon is 80 bytes. Reporting it is noise that pushes
   * the findings people can act on further down the page.
   */
  readonly minSavingBytes?: number;
  /**
   * Relative arm, in whole percent. Defaults to 10.
   *
   * Catches small files that shrink a lot, where the percentage is the meaningful
   * number and the byte count never will be.
   */
  readonly minSavingPercent?: number;
  /**
   * Absolute arm, in bytes. Defaults to 100 000.
   *
   * Catches big files that shrink a little. **Percentage is a bad proxy for value
   * once a file is large**: an 8 MB asset that shrinks 9% saves 720 KB and is very
   * likely the single biggest win in the repository, yet a percentage-only rule
   * hides it. The two arms are an `or` under the floor's `and`, so neither kind of
   * win can be lost.
   */
  readonly largeSavingBytes?: number;
}

export interface AuditOptions {
  readonly graph: Graph;
  /**
   * What the sweep found. Required: without it every zero-reference asset would
   * be reported as confidently `dead`, which is the false positive R8 exists to
   * prevent. Pass an empty result only when there is genuinely nothing unread.
   */
  readonly sweep: SweepResult;
  /**
   * Probe results, keyed by nothing — matched on `relative`.
   *
   * Absent means `--no-probe`: `oversized` and `format-opportunity` are simply not
   * produced, and the report says so rather than showing zero of each.
   */
  readonly probes?: readonly AssetProbe[];
  /** Used only to turn a broken reference's offset into a line. */
  readonly readFile: ReadFilePort;
  /** Public directories relative to the root, as the resolver was given them. */
  readonly publicDirs?: readonly string[];
  /**
   * Directories whose framework reads certain filenames without being told to.
   *
   * From `detectConventionRoots(discovery)` — a pure function over the file list, so
   * this module stays off the disk. Absent means the check does not run, which is
   * correct for a project that is not one of those frameworks and is what the other
   * two validation repositories exercise.
   */
  readonly conventionRoots?: readonly ConventionRoot[];
  readonly thresholds?: AuditThresholds;
  /**
   * Content hashes by POSIX-relative path, for the `duplicate` finding.
   *
   * ⚠️ **Absent means the check did not run**, and the report says so rather than
   * showing zero — the same distinction `probes` already carries, and the reason rule 9
   * calls a silent skip a P0. "No duplicates" and "nobody looked" are different
   * answers and a reader cannot tell them apart from a count.
   *
   * Only the assets `hashCandidates` selects need be present: an asset whose size no
   * other asset shares cannot be a duplicate, so one missing from this map is one
   * nothing could have matched rather than one we failed to check.
   */
  readonly contentHashes?: ReadonlyMap<string, string>;
}

export interface AuditResult {
  /** Every finding, ordered for the report. */
  readonly findings: readonly Finding[];
  /**
   * How many `dead` findings sit under the public directory.
   *
   * The rider on R10: those assets may be referenced from outside the repository —
   * a CMS, an email template, another site — and we can never know. One caveat
   * line naming the count is honest; hedging each of them on a bare possibility is
   * not, and is exactly how the global hedge degenerated.
   */
  readonly publicDirDeadCount: number;
  /**
   * Unreferenced assets a framework reads by filename, and why (R17).
   *
   * They produce **no** `dead` finding, because they are not dead. Rule 9 is why
   * this is a list rather than nothing: without it the headline's "N not
   * referenced" would exceed the findings by an unexplained amount, and silently
   * dropping an asset from a report is the failure this project exists to be the
   * opposite of.
   */
  readonly conventionLinked: readonly ConventionLink[];
  /** Source files that could not be re-read to cite a line, sorted. */
  readonly unreadableSources: readonly { readonly relative: string; readonly reason: string }[];
  /** Whether a probe ran at all. `false` means oversized and opportunities are absent. */
  readonly probed: boolean;
  /**
   * Whether duplicates were looked for at all.
   *
   * ⚠️ Separate from the count, because **"none found" and "nobody looked" are
   * different answers** and a zero cannot tell them apart. Rule 9 calls the second one
   * a silent skip, and the report prints a caveat rather than an implied zero.
   */
  readonly duplicatesChecked: boolean;
}

/**
 * Product judgement, not measurements — so they are documented defaults rather than
 * settled numbers, and §5.1(c)/(d) validates them against real repositories by
 * recording the finding distribution and asking whether a threshold produced noise
 * or hid something. Config overrides all of them (§1.2).
 */
const DEFAULT_THRESHOLDS = {
  maxBytes: 500_000,
  maxWidth: 4_000,
  maxHeight: 4_000,
  minSavingBytes: 1_024,
  minSavingPercent: 10,
  largeSavingBytes: 100_000,
} as const;

/** Produce every finding the available evidence supports. */
export async function audit(options: AuditOptions): Promise<AuditResult> {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  const publicPrefixes = normalisePublicDirs(options.publicDirs);

  const { findings: broken, unreadableSources } = await brokenFindings(options);
  // One diagnosis instead of N symptoms. See `resolutionHealth`: below the floor the
  // engine has not established where root-relative paths are served from, and a
  // `broken` finding produced in that state is a statement about our configuration
  // rather than about the user's code.
  const health = resolutionHealth(options.graph);
  const reported: (BrokenFinding | ServingRootUnknownFinding)[] = health.servingRootUnknown
    ? diagnoseServingRoot(broken, health)
    : broken;
  const { findings: dead, conventionLinked } = deadFindings(options, publicPrefixes);
  // `AssetProbe` measures pixels and `discover` measured bytes, so the two are
  // joined here — the one place that holds both — rather than by threading the
  // graph down into every size rule.
  const bytesByAsset = new Map(
    options.graph.assets.map((node) => [node.asset.relative, node.asset.bytes]),
  );
  const probeFindings =
    options.probes === undefined ? [] : sizeFindings(options.probes, thresholds, bytesByAsset);

  // §1.1's fifth finding. Set-scoped, so it joins the list rather than being derived
  // per asset like the other four.
  const duplicates: Finding[] =
    options.contentHashes === undefined
      ? []
      : findDuplicates(
          options.graph.assets.map((node) => node.asset),
          options.contentHashes,
        ).map((set) => ({
          kind: 'duplicate' as const,
          assets: set.assets,
          bytes: set.bytes,
          wastedBytes: set.wastedBytes,
        }));

  return {
    findings: [...dead, ...reported, ...probeFindings, ...duplicates].sort(byReportOrder),
    publicDirDeadCount: dead.filter((finding) => finding.kind === 'dead' && finding.inPublicDir)
      .length,
    conventionLinked,
    unreadableSources,
    probed: options.probes !== undefined,
    duplicatesChecked: options.contentHashes !== undefined,
  };
}

/**
 * Replace the broken findings this diagnosis explains, and only those.
 *
 * ⚠️ It explains root-relative references and nothing else. A file-relative path that
 * points at nothing is broken whatever the serving root turns out to be, so folding it
 * into this finding would hide a real defect behind an unrelated explanation and leave
 * the user with no way to see it.
 *
 * Measured on unconfigured shadcn-ui: 116 broken findings, of which 115 are
 * root-relative. The first version of this suppressed all 116, and the odd one out was
 * a genuinely broken relative path.
 */
function diagnoseServingRoot(
  broken: readonly BrokenFinding[],
  health: ResolutionHealth,
): (BrokenFinding | ServingRootUnknownFinding)[] {
  const explained = broken.filter((finding) => finding.rawPath.startsWith('/'));
  const unexplained = broken.filter((finding) => !finding.rawPath.startsWith('/'));

  return [
    {
      kind: 'serving-root-unknown',
      linked: health.linked,
      checkable: health.checkable,
      suppressedBroken: explained.length,
    },
    ...unexplained,
  ];
}

/**
 * `dead` and `possibly-dead`, decided per asset by the sweep.
 *
 * The evidence, not a global flag, is what separates them — and a hedge from an
 * unresolved reference cites file, line and the raw path, which is the difference
 * between a hint and an instruction.
 */
function deadFindings(
  options: AuditOptions,
  publicPrefixes: readonly string[],
): {
  findings: (DeadFinding | PossiblyDeadFinding)[];
  conventionLinked: ConventionLink[];
} {
  const findings: (DeadFinding | PossiblyDeadFinding)[] = [];
  const conventionLinked: ConventionLink[] = [];
  const roots = options.conventionRoots ?? [];

  for (const node of unreferencedAssets(options.graph)) {
    const asset = node.asset.relative;

    // R17. Before the hedge, not after: an asset a framework reads by filename is
    // **alive**, and `possibly-dead` would be evasive rather than merely weaker —
    // a hedge says *we do not know*, and here we do. It is checked first for the
    // same reason: nothing below this line has anything true to say about it.
    const convention = conventionLinkFor(asset, roots);
    if (convention !== null) {
      conventionLinked.push(convention);
      continue;
    }

    const inPublicDir = publicPrefixes.some((prefix) => asset.startsWith(prefix));
    const mentions = options.sweep.mentions.get(asset) ?? [];
    const [first, ...rest] = mentions;

    findings.push(
      first === undefined
        ? { kind: 'dead', asset, bytes: node.asset.bytes, inPublicDir }
        : {
            kind: 'possibly-dead',
            asset,
            bytes: node.asset.bytes,
            inPublicDir,
            evidence: [first, ...rest],
          },
    );
  }

  return { findings, conventionLinked };
}

/** Every asserted path pointing at nothing, cited so a reviewer can open it. */
async function brokenFindings(
  options: AuditOptions,
): Promise<{ findings: BrokenFinding[]; unreadableSources: AuditResult['unreadableSources'] }> {
  const references = options.graph.byResolution.broken;
  if (references.length === 0) return { findings: [], unreadableSources: [] };

  const { citations, unreadable } = await citeReferences({
    references,
    root: options.graph.root,
    readFile: options.readFile,
  });

  const findings = references.map((reference): BrokenFinding => {
    const citation = citations.get(reference);
    return {
      kind: 'broken',
      file: citation?.file ?? reference.file,
      line: citation?.line ?? null,
      where: citation?.where ?? reference.file,
      rawPath: reference.rawPath,
    };
  });

  return { findings, unreadableSources: unreadable };
}

/** `oversized` and `format-opportunity` — the two that need pixels. */
function sizeFindings(
  probes: readonly AssetProbe[],
  thresholds: Required<AuditThresholds>,
  bytesByAsset: ReadonlyMap<string, number>,
): Finding[] {
  const findings: Finding[] = [];

  for (const probe of probes) {
    const bytes = bytesByAsset.get(probe.relative) ?? 0;
    const oversized = oversizedFinding(probe, thresholds, bytes);
    if (oversized !== null) findings.push(oversized);
    findings.push(...opportunities(probe, thresholds, bytes));
  }

  return findings;
}

function oversizedFinding(
  probe: AssetProbe,
  thresholds: Required<AuditThresholds>,
  // Known even when the header would not decode, so a corrupt 40 MB file is still
  // reported as oversized rather than vanishing from the audit entirely.
  bytes: number,
): OversizedFinding | null {
  const exceeded: OversizeDimension[] = [];

  if (bytes > thresholds.maxBytes) exceeded.push('bytes');
  if ((probe.metadata?.height ?? 0) > thresholds.maxHeight) exceeded.push('height');
  if ((probe.metadata?.width ?? 0) > thresholds.maxWidth) exceeded.push('width');

  const [first, ...rest] = exceeded.sort(compareStrings);
  if (first === undefined) return null;

  return {
    kind: 'oversized',
    asset: probe.relative,
    bytes,
    width: probe.metadata?.width ?? null,
    height: probe.metadata?.height ?? null,
    exceeded: [first, ...rest],
  };
}

function* opportunities(
  probe: AssetProbe,
  thresholds: Required<AuditThresholds>,
  bytes: number,
): Generator<FormatOpportunityFinding> {
  // A zero-byte source has no saving to express as a percentage of.
  if (bytes === 0) return;

  for (const encoded of probe.encoded) {
    const savedBytes = bytes - encoded.bytes;

    // Floored whole percent: a report number, and one that two runs agree on
    // without anyone reasoning about float formatting.
    const savedPercent = Math.floor((savedBytes / bytes) * 100);

    // Floor AND (relative OR absolute). The floor kills icon noise; the two arms
    // catch the two unlike kinds of win — a small file that shrinks a lot, and a
    // large one that shrinks a little. Requiring both arms would drop a 720 KB
    // saving on an 8 MB asset for shrinking "only" 9%, which is the finding a
    // user most wants to see.
    if (savedBytes < thresholds.minSavingBytes) continue;
    if (savedPercent < thresholds.minSavingPercent && savedBytes < thresholds.largeSavingBytes) {
      continue;
    }

    yield {
      kind: 'format-opportunity',
      asset: probe.relative,
      from: probe.metadata?.format ?? 'unknown',
      to: encoded.format,
      quality: encoded.quality,
      bytes,
      wouldBe: encoded.bytes,
      savedBytes,
      savedPercent,
    };
  }
}

/**
 * Serving roots as path prefixes, with a trailing slash.
 *
 * A root of `''` — a plain static site serving from the project root — yields no
 * prefix at all rather than one matching everything: marking every asset public
 * would make the caveat meaningless.
 */
/**
 * Public directories as path prefixes, where the empty string means the whole tree.
 *
 * A project can serve from its own root. A hand-written static site with no build step
 * is the ordinary case: there is no `public/`, the repository *is* what gets uploaded,
 * and every file in it is reachable from outside. That is spelled `''`.
 *
 * This used to filter `''` out. The filter looks defensive and reads as though it is
 * removing a meaningless entry, but `''` is not meaningless here: it is the statement
 * that everything is public, and dropping it produced an empty prefix list, which says
 * the opposite. Every asset then scored `inPublicDir: false`, `publicDirDeadCount`
 * summed to zero, and the caveat warning that an unreferenced image may be linked from
 * outside the repository was never emitted at all. On `railsgirls-com` that was 903
 * unreferenced assets offered with no such warning, on the one repository in the corpus
 * where the whole tree is the public directory.
 *
 * An empty prefix matches every path, which is what it should mean.
 */
function normalisePublicDirs(publicDirs: readonly string[] | undefined): readonly string[] {
  return (publicDirs ?? []).map((publicDir) =>
    publicDir === '' || publicDir.endsWith('/') ? publicDir : `${publicDir}/`,
  );
}

/**
 * Report order: by kind, then by the asset or file the finding is about.
 *
 * Deterministic, and grouped the way a reader wants it — every broken reference
 * together, every dead asset together — rather than interleaved by path.
 */
const KIND_ORDER: Record<Finding['kind'], number> = {
  // Ahead of everything, because when it is present it is the reason the rest of the
  // report looks the way it does.
  'serving-root-unknown': -1,
  broken: 0,
  dead: 1,
  'possibly-dead': 2,
  oversized: 3,
  'format-opportunity': 4,
  // Last, and deliberately: it is the only finding with no single asset at fault, so
  // it reads as a footnote to the list rather than an accusation inside it.
  duplicate: 5,
};

function byReportOrder(a: Finding, b: Finding): number {
  const byKind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  if (byKind !== 0) return byKind;

  // 🔴 Duplicates order by what is worth recovering, not by path. Every other kind
  // sorts by path because every other kind is about one asset and a reader scans for a
  // name; a duplicate set is about an amount, and the largest is the one worth acting
  // on first.
  //
  // ⚠️ **This lives here because sorting it in `findDuplicates` did not survive.** It
  // was sorted correctly there and then re-sorted by this function, so the report
  // rendered 562 B, then 2.5 KB, then 136.4 KB — caught by reading the rendered report
  // on `scratch-www`, not by a test, which is the fourth time this phase.
  if (a.kind === 'duplicate' && b.kind === 'duplicate') {
    return b.wastedBytes - a.wastedBytes || compareStrings(subjectOf(a), subjectOf(b));
  }

  return compareStrings(subjectOf(a), subjectOf(b)) || compareStrings(detailOf(a), detailOf(b));
}

function subjectOf(finding: Finding): string {
  if (finding.kind === 'broken') return finding.file;
  // At most one per run and sorted first, so it needs no subject to be ordered by.
  if (finding.kind === 'serving-root-unknown') return '';
  // A set has no single subject. Its first path is already the alphabetically first of
  // the set, so ordering by it is stable and reads the way a reader would expect.
  if (finding.kind === 'duplicate') return finding.assets[0] ?? '';
  return finding.asset;
}

function detailOf(finding: Finding): string {
  if (finding.kind === 'broken') return finding.rawPath;
  if (finding.kind === 'format-opportunity') return finding.to;
  return '';
}
