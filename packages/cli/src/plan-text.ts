/** Words the summaries share: what an applied run wrote, counts, and references that move. */

import type { Manifest } from 'upfly-core';

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
