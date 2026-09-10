/**
 * Render a report for a person.
 *
 * Two rules shape this, and they pull against each other.
 *
 * **The numbers people screenshot come first, then the skipped list — before the
 * findings.** That ordering is deliberate and slightly uncomfortable: it puts what
 * the tool *could not do* above what it found. The previous generation of this
 * project failed by failing silently, and a limitation printed after eighty findings
 * is a limitation nobody reads. If the skipped list is long, that is information.
 *
 * **Deterministic** (rule 11). No timestamps, no durations, and no `toLocaleString`
 * anywhere — locale-dependent formatting would make the same repository render
 * differently on two machines, which is the same class of bug as sorting with
 * `localeCompare`. Every number here is formatted by hand.
 *
 * No colour codes either. Colour is the CLI's business, since it is the layer that
 * knows about TTYs and `NO_COLOR`.
 */

import type { Finding } from './audit.js';
import { compareStrings } from './paths.js';
import type { Report, SkipStage, SkippedItem } from './report.js';
import type { MentionSource } from './sweep.js';

/** Render the report as plain text. */
export function renderReport(report: Report): string {
  const lines: string[] = [];

  lines.push(...headline(report));
  lines.push(...skippedSection(report));
  lines.push(...findingsSection(report));
  lines.push(...caveatSection(report));

  return `${lines.join('\n').trimEnd()}\n`;
}

function headline(report: Report): string[] {
  const { summary } = report;
  const unreferenced = summary.assets - summary.referencedAssets;

  const lines = [
    'Upfly audit',
    '',
    `  ${count(summary.assets, 'image')}, ${bytes(summary.assetBytes)}`,
    `  ${count(summary.references, 'reference')} across ${count(summary.sourceFiles, 'source file')} — ${summary.linkedReferences} linked`,
    `  ${summary.referencedAssets} referenced, ${unreferenced} not`,
  ];

  if (summary.potentialSavingBytes > 0) {
    lines.push(`  ${bytes(summary.potentialSavingBytes)} of measured savings available`);
  } else if (!summary.probed) {
    lines.push('  images were not decoded (--no-probe), so savings are unknown');
  }

  lines.push('');
  return lines;
}

const STAGE_LABEL: Record<SkipStage, string> = {
  discovery: 'could not be read',
  scan: 'could not be parsed',
  sweep: 'could not be searched',
  citation: 'could not be re-read for a line number',
  measurement: 'could not be measured',
};

/**
 * What the engine declined to do — printed **before** the findings.
 *
 * The unsafe references live here too. They are not failures, but they are the same
 * kind of statement: paths the engine will not touch, and the number a user is
 * entitled to see before believing anything else in the report.
 */
function skippedSection(report: Report): string[] {
  const { skipped, references } = report;
  // The discarded count belongs to this guard too. Leaving it out made the line
  // below unreachable on exactly the common case — a clean repository with no
  // skips and no unsafe references, but a `package.json` full of path-shaped
  // strings. Every fixture tree has zero of those, so nothing caught it.
  if (skipped.length === 0 && references.unsafe.length === 0 && references.discardedCount === 0) {
    return ['Nothing was skipped.', ''];
  }

  const lines: string[] = [];

  if (skipped.length > 0) {
    lines.push(`Skipped — ${count(skipped.length, 'thing')} Upfly could not handle`, '');
    for (const [stage, items] of groupByStage(skipped)) {
      lines.push(`  ${STAGE_LABEL[stage]}:`);
      for (const item of items) lines.push(`    ${item.what} — ${item.reason}`);
      lines.push('');
    }
  }

  if (references.unsafe.length > 0) {
    lines.push(`${count(references.unsafe.length, 'reference')} could not be resolved safely`, '');
    for (const entry of references.unsafe) {
      lines.push(`  ${entry.file}  ${entry.rawPath}`);
      lines.push(`    ${entry.resolution} — ${entry.reason}`);
    }
    lines.push('');
  }

  if (references.discardedCount > 0) {
    // Name the flag that actually produces the list. `--json` alone gives a bare
    // integer, and pointing someone at data that is not there costs more trust
    // than saying nothing would.
    const verb =
      references.discardedCount === 1 ? 'was not an asset reference' : 'were not asset references';
    const hint = references.discarded === null ? ' (use --include-discarded to list them)' : '';
    lines.push(`${count(references.discardedCount, 'path-shaped string')} ${verb}${hint}`, '');

    // Asked for explicitly, so shown — the flag would otherwise appear to do
    // nothing unless `--json` were passed alongside it.
    for (const entry of references.discarded ?? []) {
      lines.push(`  ${entry.file}  ${entry.rawPath}`);
    }
    if (references.discarded !== null) lines.push('');
  }

  return lines;
}

function findingsSection(report: Report): string[] {
  if (report.findings.length === 0) return ['No findings.', ''];

  const lines = [`Findings — ${count(report.findings.length, 'item')}`, ''];
  let previous: Finding['kind'] | null = null;

  for (const finding of report.findings) {
    // Hedges are not a flat list: they are three different statements about why an
    // asset has no references, and they are rendered as such. See below.
    if (finding.kind === 'possibly-dead') {
      if (previous !== 'possibly-dead') {
        if (previous !== null) lines.push('');
        lines.push(...possiblyDeadSection(report));
        previous = 'possibly-dead';
      }
      continue;
    }

    if (finding.kind !== previous) {
      if (previous !== null) lines.push('');
      lines.push(`  ${headingFor(finding.kind, report)}`);
      previous = finding.kind;
    }
    lines.push(...describe(finding));
  }

  lines.push('');
  return lines;
}

type PossiblyDead = Extract<Finding, { kind: 'possibly-dead' }>;

/**
 * Most actionable first. A finding is filed under the best evidence it carries,
 * and still prints all of it.
 */
const MENTION_RANK: readonly MentionSource[] = [
  'unscanned-file',
  'scanned-file',
  'unresolved-reference',
];

/**
 * What each source means to the person reading, which is the only axis that
 * matters here: the three differ in what the user can *do*.
 */
const MENTION_HEADING: Record<MentionSource, string> = {
  'unscanned-file': 'in a file no adapter reads — an adapter or a config entry would resolve these',
  'scanned-file':
    'in text Upfly read but no adapter claimed — the weakest evidence; look if the asset matters',
  'unresolved-reference':
    'by a path Upfly read but could not resolve — nothing to fix; those files parse fine',
};

/**
 * The hedges, split by what the evidence actually is and grouped by the file that
 * named them.
 *
 * The single heading this replaced — *"named somewhere Upfly cannot read"* — was
 * **false for the majority of the findings it headed**: 119 of 140 on `astro-docs`,
 * 5 of 10 on `eleventy-docs`, 5 of 8 on `shadcn-ui` have no `unscanned-file`
 * evidence at all. `src/data/logos.ts` is ordinary TypeScript that parses perfectly;
 * `'gitbook.svg'` simply is not a resolvable path. A user who follows that citation
 * opens a readable file and concludes the tool is broken — so one wrong sentence
 * costs the credibility of a finding that was right.
 *
 * Grouping is by **citing file**, not by source. "120 assets are named in
 * `src/data/logos.ts`" is a fact somebody can act on; "120 unresolved-reference" is
 * our internal taxonomy, and one file explaining 86% of a repository's hedges is the
 * whole finding.
 */
function possiblyDeadSection(report: Report): string[] {
  const findings = report.findings.filter(
    (finding): finding is PossiblyDead => finding.kind === 'possibly-dead',
  );
  const lines = [
    `  possibly unreferenced (${findings.length}) — each is named somewhere, but not by a reference Upfly could follow`,
  ];

  for (const source of MENTION_RANK) {
    const group = findings.filter((finding) => bestSource(finding) === source);
    if (group.length === 0) continue;

    lines.push('', `    named ${MENTION_HEADING[source]} (${group.length})`);

    const byFile = new Map<string, PossiblyDead[]>();
    for (const finding of group) {
      const file = citingFile(finding, source);
      byFile.set(file, [...(byFile.get(file) ?? []), finding]);
    }

    // Biggest cause first, because that is the one worth acting on — with ties
    // broken on the path, so rule 11 survives two files naming the same number.
    const files = [...byFile].sort(
      (a, b) => b[1].length - a[1].length || compareStrings(a[0], b[0]),
    );

    for (const [file, assets] of files) {
      lines.push(`      ${file} — ${count(assets.length, 'asset')}`);
      for (const finding of assets) {
        lines.push(`        ${finding.asset}  ${bytes(finding.bytes)}`);
        // Every mention, not only the one that filed it: the citation is the whole
        // point of hedging per asset rather than globally.
        for (const mention of finding.evidence) {
          lines.push(`          named in ${mention.where}: ${mention.quote}`);
        }
      }
    }
  }

  return lines;
}

/** The most actionable source among a finding's evidence. */
function bestSource(finding: PossiblyDead): MentionSource {
  let best = finding.evidence[0].source;
  for (const mention of finding.evidence) {
    if (MENTION_RANK.indexOf(mention.source) < MENTION_RANK.indexOf(best)) best = mention.source;
  }
  return best;
}

/** The file that filed this finding, without the line number `where` carries. */
function citingFile(finding: PossiblyDead, source: MentionSource): string {
  const mention = finding.evidence.find((entry) => entry.source === source);
  const where = mention?.where ?? finding.evidence[0].where;
  return where.replace(/:\d+$/, '');
}

function headingFor(kind: Finding['kind'], report: Report): string {
  const total = report.summary.findings[kind];
  switch (kind) {
    case 'broken':
      return `broken references (${total}) — these point at nothing`;
    case 'dead':
      return `unreferenced images (${total})`;
    case 'possibly-dead':
      // Unreachable: `findingsSection` routes these through `possiblyDeadSection`,
      // which heads each of the three evidence kinds separately. Kept so the
      // exhaustive switch still compiles and an eighth finding still breaks it.
      return `possibly unreferenced (${total})`;
    case 'oversized':
      return `oversized images (${total})`;
    case 'format-opportunity':
      return `smaller as another format (${total}) — measured, not estimated`;
    default: {
      const unhandled: never = kind;
      return unhandled;
    }
  }
}

function describe(finding: Finding): string[] {
  switch (finding.kind) {
    case 'broken':
      return [`    ${finding.where}  ${finding.rawPath}`];
    case 'dead':
      return [`    ${finding.asset}  ${bytes(finding.bytes)}`];
    case 'possibly-dead':
      return [
        `    ${finding.asset}  ${bytes(finding.bytes)}`,
        // The citation is the whole point of hedging per asset rather than
        // globally: it turns a warning into somewhere to look.
        ...finding.evidence.map((mention) => `      named in ${mention.where}: ${mention.quote}`),
      ];
    case 'oversized':
      return [
        `    ${finding.asset}  ${bytes(finding.bytes)}${dimensions(finding.width, finding.height)} — over ${finding.exceeded.join(' and ')}`,
      ];
    case 'format-opportunity':
      return [
        `    ${finding.asset}  ${bytes(finding.bytes)} → ${bytes(finding.wouldBe)} as ${finding.to}  (saves ${bytes(finding.savedBytes)}, ${finding.savedPercent}%)`,
      ];
    default: {
      const unhandled: never = finding;
      return unhandled;
    }
  }
}

function caveatSection(report: Report): string[] {
  if (report.caveats.length === 0) return [];

  const lines = ['Worth knowing', ''];
  for (const caveat of report.caveats) {
    // The message already carries its own count, so nothing here has to compose a
    // sentence out of a number and a fragment.
    lines.push(`  ${caveat.message}${caveat.detail.length > 0 ? ':' : ''}`);
    for (const detail of caveat.detail) lines.push(`    ${detail}`);
  }
  lines.push('');
  return lines;
}

function groupByStage(items: readonly SkippedItem[]): [SkipStage, SkippedItem[]][] {
  const groups = new Map<SkipStage, SkippedItem[]>();
  for (const item of items) {
    const list = groups.get(item.stage);
    if (list === undefined) groups.set(item.stage, [item]);
    else list.push(item);
  }
  // `skipped` arrives sorted by stage, so insertion order is already deterministic.
  return [...groups];
}

/** `1 image` / `2 images`. English pluralisation, which is the only language here. */
function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}

/**
 * Bytes, formatted by hand.
 *
 * Deliberately not `Intl.NumberFormat` or `toLocaleString`: those are
 * locale-dependent, so the same repository would render `1.5 MB` on one machine and
 * `1,5 MB` on another and rule 11's byte-identical output would quietly be false.
 * Decimal units, because that is what file managers show.
 */
function bytes(value: number): string {
  if (value < 1_000) return `${value} B`;
  if (value < 1_000_000) return `${tenths(value / 1_000)} KB`;
  if (value < 1_000_000_000) return `${tenths(value / 1_000_000)} MB`;
  return `${tenths(value / 1_000_000_000)} GB`;
}

/** One decimal place, without trailing `.0`, and without locale rules. */
function tenths(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
}

function dimensions(width: number | null, height: number | null): string {
  return width === null || height === null ? '' : `, ${width}×${height}`;
}
