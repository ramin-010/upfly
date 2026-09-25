/** The plan as `upfly optimize` prints it after the report, and what an applied run wrote. */

import {
  type Graph,
  type Manifest,
  type OptimizationPlan,
  type PublicPolicy,
  formatBytes,
} from 'upfly-core';

/**
 * The plan as text: what converts, which files change, and what happens to each original.
 *
 * @param plan the plan the run made, identical on a dry run and an applied one
 * @param graph the graph it was made from, for each image's size
 * @param policy whether originals are kept or replaced
 */
export function renderPlan(plan: OptimizationPlan, graph: Graph, policy: PublicPolicy): string[] {
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
    for (const conversion of plan.conversions) {
      const size = sizes.get(conversion.asset) ?? 0;
      lines.push(
        `    ${conversion.asset} → ${conversion.target}  ${formatBytes(size)} → ${formatBytes(size - conversion.savedBytes)}`,
      );
    }
  }

  if (plan.rewrites.length > 0) {
    const references = plan.rewrites.reduce((sum, rewrite) => sum + rewrite.edits.length, 0);
    lines.push(
      `  Update references: ${count(references, 'reference')} in ${count(plan.rewrites.length, 'file')}`,
    );
    for (const rewrite of plan.rewrites) {
      lines.push(`    ${rewrite.file}  ${count(rewrite.edits.length, 'reference')}`);
    }
  }

  lines.push(...originalsLines(plan, policy), '');
  return lines;
}

function originalsLines(plan: OptimizationPlan, policy: PublicPolicy): string[] {
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
    for (const conversion of removed) lines.push(`    ${conversion.asset}`);
  }
  if (plan.keptOriginals.length > 0) {
    lines.push(
      `  Keep originals: ${count(plan.keptOriginals.length, 'image')}, each for its reason`,
    );
    for (const kept of plan.keptOriginals) lines.push(`    ${kept.asset}  ${kept.reason}`);
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
