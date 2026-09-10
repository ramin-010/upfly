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
import type { Report, SkipStage, SkippedItem } from './report.js';

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
  if (skipped.length === 0 && references.unsafe.length === 0) {
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
    lines.push(
      `${references.discardedCount} path-shaped strings were not asset references (use --json to inspect)`,
      '',
    );
  }

  return lines;
}

function findingsSection(report: Report): string[] {
  if (report.findings.length === 0) return ['No findings.', ''];

  const lines = [`Findings — ${count(report.findings.length, 'item')}`, ''];
  let previous: Finding['kind'] | null = null;

  for (const finding of report.findings) {
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

function headingFor(kind: Finding['kind'], report: Report): string {
  const total = report.summary.findings[kind];
  switch (kind) {
    case 'broken':
      return `broken references (${total}) — these point at nothing`;
    case 'dead':
      return `unreferenced images (${total})`;
    case 'possibly-dead':
      return `possibly unreferenced (${total}) — named somewhere Upfly cannot read`;
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
