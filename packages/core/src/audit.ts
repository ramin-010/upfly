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
import type { Graph } from './graph.js';
import { unreferencedAssets } from './graph.js';
import { compareStrings } from './paths.js';
import type { AssetProbe, EncodeFormat } from './probe.js';
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
}

export type Finding =
  | DeadFinding
  | PossiblyDeadFinding
  | BrokenFinding
  | OversizedFinding
  | FormatOpportunityFinding;

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
  readonly thresholds?: AuditThresholds;
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
  /** Source files that could not be re-read to cite a line, sorted. */
  readonly unreadableSources: readonly { readonly relative: string; readonly reason: string }[];
  /** Whether a probe ran at all. `false` means oversized and opportunities are absent. */
  readonly probed: boolean;
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
  const dead = deadFindings(options, publicPrefixes);
  // `AssetProbe` measures pixels and `discover` measured bytes, so the two are
  // joined here — the one place that holds both — rather than by threading the
  // graph down into every size rule.
  const bytesByAsset = new Map(
    options.graph.assets.map((node) => [node.asset.relative, node.asset.bytes]),
  );
  const probeFindings =
    options.probes === undefined ? [] : sizeFindings(options.probes, thresholds, bytesByAsset);

  return {
    findings: [...dead, ...broken, ...probeFindings].sort(byReportOrder),
    publicDirDeadCount: dead.filter((finding) => finding.kind === 'dead' && finding.inPublicDir)
      .length,
    unreadableSources,
    probed: options.probes !== undefined,
  };
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
): (DeadFinding | PossiblyDeadFinding)[] {
  const findings: (DeadFinding | PossiblyDeadFinding)[] = [];

  for (const node of unreferencedAssets(options.graph)) {
    const asset = node.asset.relative;
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

  return findings;
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
function normalisePublicDirs(publicDirs: readonly string[] | undefined): readonly string[] {
  return (publicDirs ?? [])
    .filter((publicDir) => publicDir !== '')
    .map((publicDir) => (publicDir.endsWith('/') ? publicDir : `${publicDir}/`));
}

/**
 * Report order: by kind, then by the asset or file the finding is about.
 *
 * Deterministic, and grouped the way a reader wants it — every broken reference
 * together, every dead asset together — rather than interleaved by path.
 */
const KIND_ORDER: Record<Finding['kind'], number> = {
  broken: 0,
  dead: 1,
  'possibly-dead': 2,
  oversized: 3,
  'format-opportunity': 4,
};

function byReportOrder(a: Finding, b: Finding): number {
  return (
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
    compareStrings(subjectOf(a), subjectOf(b)) ||
    compareStrings(detailOf(a), detailOf(b))
  );
}

function subjectOf(finding: Finding): string {
  return finding.kind === 'broken' ? finding.file : finding.asset;
}

function detailOf(finding: Finding): string {
  if (finding.kind === 'broken') return finding.rawPath;
  if (finding.kind === 'format-opportunity') return finding.to;
  return '';
}
