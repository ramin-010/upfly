/** The plan as `upfly optimize` prints it after the report, and what an applied run wrote. */

import type { Manifest, OptimizationPlan, PublicPolicy } from 'upfly-core';
import { type Graph, formatBytes } from 'upfly-core/internal';

/** How much of the plan to list. */
export interface PlanTextOptions {
  /**
   * List every original kept, rather than the first twenty: the report file holds each
   * reason the summary points to.
   */
  readonly everyOriginalKept?: boolean;
}

/**
 * The plan as text: what converts, which files change, and what happens to each original.
 *
 * @param plan the plan the run made, identical on a dry run and an applied one
 * @param graph the graph it was made from, for each image's size
 * @param policy whether originals are kept or replaced
 * @param options how much of the plan to list
 */
export function renderPlan(
  plan: OptimizationPlan,
  graph: Graph,
  policy: PublicPolicy,
  options: PlanTextOptions = {},
): string[] {
  const lines = ['Plan', ''];
  if (plan.conversions.length === 0 && plan.rewrites.length === 0) {
    lines.push('  Nothing to convert and no reference to update.', '');
    return lines;
  }

  const sizes = new Map(graph.assets.map((node) => [node.asset.relative, node.asset.bytes]));
  const before = plan.conversions.reduce((sum, c) => sum + (sizes.get(c.asset) ?? 0), 0);
  const saved = plan.conversions.reduce((sum, c) => sum + c.savedBytes, 0);
  const format = plan.conversions[0]?.format === 'avif' ? 'AVIF' : 'WebP';
  if (plan.conversions.length > 0) {
    lines.push(
      `  Convert to ${format}: ${count(plan.conversions.length, 'image')}, ${formatBytes(before)} now and ${formatBytes(before - saved)} after`,
    );
    for (const conversion of plan.conversions.slice(0, LISTED)) {
      const size = sizes.get(conversion.asset) ?? 0;
      lines.push(
        `    ${conversion.asset} → ${conversion.target}  ${formatBytes(size)} → ${formatBytes(size - conversion.savedBytes)}`,
      );
    }
    lines.push(...moreThanListed(plan.conversions.length));
  }

  if (plan.rewrites.length > 0) {
    const references = plan.rewrites.reduce((sum, rewrite) => sum + rewrite.edits.length, 0);
    lines.push(
      `  Update references: ${count(references, 'reference')} in ${count(plan.rewrites.length, 'file')}`,
    );
    for (const rewrite of plan.rewrites.slice(0, LISTED)) {
      lines.push(`    ${rewrite.file}  ${count(rewrite.edits.length, 'reference')}`);
    }
    lines.push(...moreThanListed(plan.rewrites.length));
  }

  lines.push(...originalsLines(plan, policy, options.everyOriginalKept === true), '');
  return lines;
}

/**
 * How many items of a list the plan prints. The counts above each list stay whole; a big
 * project's thousands of lines would bury them, and `--json` holds every item.
 */
const LISTED = 20;

/** The line under a list cut at `LISTED`, or none when it was not cut. */
function moreThanListed(total: number): string[] {
  if (total <= LISTED) return [];
  return [`    ... and ${total - LISTED} more; the JSON output, \`--json\`, lists every one`];
}

function originalsLines(
  plan: OptimizationPlan,
  policy: PublicPolicy,
  everyKept: boolean,
): string[] {
  if (plan.conversions.length === 0) return [];
  if (policy === 'keep-original') {
    return [
      '  Originals: each stays beside its converted file. With --replace, an original is',
      '  removed once every reference to it has moved.',
    ];
  }
  const lines: string[] = [];
  const removed = plan.conversions.filter((conversion) => conversion.replacesOriginal);
  if (removed.length > 0) {
    lines.push(
      `  Remove originals: ${count(removed.length, 'image')}, each once every reference to it has moved`,
    );
    for (const conversion of removed.slice(0, LISTED)) lines.push(`    ${conversion.asset}`);
    lines.push(...moreThanListed(removed.length));
  }
  if (plan.keptOriginals.length > 0) {
    lines.push(
      `  Keep originals: ${count(plan.keptOriginals.length, 'image')}, each for its reason`,
    );
    const listed = everyKept ? plan.keptOriginals : plan.keptOriginals.slice(0, LISTED);
    for (const kept of listed) lines.push(`    ${kept.asset}  ${kept.reason}`);
    if (!everyKept) lines.push(...moreThanListed(plan.keptOriginals.length));
  }
  return lines;
}

/**
 * What an applied run wrote, by kind, from its manifest.
 *
 * @param manifest the record the run left
 */
export function writtenByKind(manifest: Manifest): {
  readonly created: string[];
  readonly changed: string[];
  readonly removed: string[];
} {
  const created: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  for (const operation of manifest.operations) {
    if (operation.kind === 'create') created.push(operation.path);
    else if (operation.kind === 'edit') changed.push(operation.path);
    else if (operation.kind === 'delete') removed.push(operation.path);
    else {
      created.push(operation.to);
      removed.push(operation.from);
    }
  }
  return { created, changed, removed };
}

/** `1 image` or `2 images`. */
export function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}

/**
 * How many of a file's references move, in words: `its 1 reference moves to ...`, `all 3 of
 * its references move to ...`, `1 of its 2 references moves to ...`, or that they stay.
 *
 * @param moved how many move
 * @param total how many name the file, at least one
 * @param to where they move, such as `to the kept copy`
 */
export function movingText(moved: number, total: number, to: string): string {
  if (moved === 0) {
    return total === 1
      ? 'its 1 reference stays as written'
      : `its ${total} references stay as written`;
  }
  if (moved === total) {
    return total === 1
      ? `its 1 reference moves ${to}`
      : `all ${total} of its references move ${to}`;
  }
  return `${moved} of its ${count(total, 'reference')} ${moved === 1 ? 'moves' : 'move'} ${to}`;
}
