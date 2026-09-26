/**
 * `SHAPES` and the coverage key's shape list are two copies of one vocabulary, and neither
 * can import the other. This test fails when they differ in either direction. See
 * "Reference shapes" in ARCHITECTURE.md.
 *
 * `reconcile` takes both lists as arguments, so the proofs below can hand it damaged ones
 * without writing to `shapes.ts` or the key.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SHAPES,
  SHAPE_IDS,
  type ShapeDeclaration,
  UNTESTED_SHAPE_IDS,
  shapeById,
} from './shapes.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const KEY_PATH = join(HERE, '..', '..', '..', 'coverage-tree', 'key', 'coverage-key.json');

interface KeyShape {
  readonly id: string;
  readonly label?: string;
  readonly absent?: string;
}
interface KeyEntry {
  readonly shape: string;
  readonly expect: string;
}
interface Key {
  readonly shapes: readonly KeyShape[];
  readonly files: readonly { readonly path: string; readonly entries: readonly KeyEntry[] }[];
}

function loadKey(): Key {
  return JSON.parse(readFileSync(KEY_PATH, 'utf8')) as Key;
}

function countByShape(key: Key): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of key.files) {
    for (const entry of file.entries) {
      counts.set(entry.shape, (counts.get(entry.shape) ?? 0) + 1);
    }
  }
  return counts;
}

interface Problem {
  readonly direction: 'missing-here' | 'missing-in-tree' | 'growth-list-now-tested';
  readonly id: string;
}

/**
 * Compare the two lists. Pure, so the proofs can damage its inputs.
 *
 * `growthList` is the one allowed asymmetry: shapes an adapter emits that the tree has no
 * instance of. `shapes.ts` declares them so the matrix can print them as a debt, since a
 * shape with no name cannot be reported as uncovered.
 */
function reconcile(input: {
  readonly engineIds: readonly string[];
  readonly treeIds: readonly string[];
  readonly growthList: readonly string[];
  readonly treeCounts: ReadonlyMap<string, number>;
}): Problem[] {
  const { engineIds, treeIds, growthList, treeCounts } = input;
  const engine = new Set(engineIds);
  const tree = new Set(treeIds);
  const growth = new Set(growthList);
  const problems: Problem[] = [];

  for (const id of treeIds) {
    if (!engine.has(id)) problems.push({ direction: 'missing-here', id });
  }
  for (const id of engineIds) {
    if (!tree.has(id) && !growth.has(id)) problems.push({ direction: 'missing-in-tree', id });
  }
  for (const id of growthList) {
    if ((treeCounts.get(id) ?? 0) > 0) problems.push({ direction: 'growth-list-now-tested', id });
  }

  return problems;
}

/**
 * Check each shape's `adapterEmitsAs` and `needsToSee`. Pure, so the proofs below can damage
 * its input.
 *
 * These declarations replace an exemption list in the measuring harness. Such a list rots
 * silently, since an entry no longer needed still suppresses; a declared id that stops
 * existing fails here instead.
 */
function auditEmitsAs(
  declarations: readonly ShapeDeclaration[],
  known: ReadonlySet<string>,
): string[] {
  const problems: string[] = [];

  for (const shape of declarations) {
    const emitsAs = shape.adapterEmitsAs;
    if (emitsAs === undefined) {
      // The reverse direction: `needsToSee` alone is a claim with nothing behind it.
      if (shape.needsToSee !== undefined) {
        problems.push(`${shape.id}: has needsToSee but no adapterEmitsAs`);
      }
      continue;
    }

    if (emitsAs.length === 0) problems.push(`${shape.id}: adapterEmitsAs is empty`);
    for (const id of emitsAs) {
      if (!known.has(id)) {
        problems.push(`${shape.id}: adapterEmitsAs names ${id}, which is not a shape`);
      }
      if (id === shape.id) problems.push(`${shape.id}: adapterEmitsAs names itself`);
    }
    // The field says the adapter cannot see the distinction. Unless `needsToSee` names what
    // it is missing, a reader has nothing to check against the code.
    if ((shape.needsToSee ?? '').length === 0) {
      problems.push(`${shape.id}: adapterEmitsAs without needsToSee naming the resolver fact`);
    }
  }

  return problems;
}

describe('the shape vocabulary reconciles with the coverage tree', () => {
  it('agrees with the tree in both directions', () => {
    const key = loadKey();
    const problems = reconcile({
      engineIds: SHAPES.map((s) => s.id),
      treeIds: key.shapes.map((s) => s.id),
      growthList: UNTESTED_SHAPE_IDS,
      treeCounts: countByShape(key),
    });

    expect(
      problems,
      'The vocabulary and the coverage tree disagree. The TREE defines the list: a shape ' +
        'it declares must exist in shapes.ts. A shape only shapes.ts has is drift, unless ' +
        'it is on the growth list (UNTESTED_SHAPE_IDS) with a `why` naming the construct.',
    ).toEqual([]);
  });

  it('agrees with the tree about which shapes have no instances', () => {
    const key = loadKey();
    const counts = countByShape(key);

    // A shape the tree declares with an `absent` reason has no instances by design. One
    // without that reason and with no instances already fails check-key, so this asserts
    // the two instruments agree about which is which.
    for (const shape of key.shapes.filter((s) => s.absent !== undefined)) {
      expect(
        counts.get(shape.id) ?? 0,
        `${shape.id} is declared absent but the key has instances of it`,
      ).toBe(0);
    }
  });

  it('gives every declared shape an emission class, and a reason where it is not obvious', () => {
    // Widened on purpose: `SHAPES` is `as const` so `ShapeId` can be derived from it, which
    // narrows each entry to its own literal type, and then `why` does not exist on the
    // entries that lack one.
    const declarations: readonly ShapeDeclaration[] = SHAPES;
    for (const shape of declarations) {
      expect(['engine', 'gap', 'declined', 'unclaimed'], `${shape.id}`).toContain(shape.emission);

      // A row that reads backwards (a zero is correct, a non-zero is the failure) must say
      // why, unless its family already does: a `decoy.*` or `path.*` shape declines by
      // definition, and asking for prose there only teaches people to write filler.
      if (BACKWARD_READING.includes(shape.emission) && !familyExplains(shape)) {
        const rule = 'A row that reads backwards has to say why.';
        expect(
          (shape.why ?? '').length > 0,
          `${shape.id} reads backwards (${shape.emission}) and its family does not explain that. ${rule}`,
        ).toBe(true);
      }
    }
  });

  it('declares every `adapterEmitsAs` id as a real shape, with the fact it cannot see', () => {
    expect(auditEmitsAs(SHAPES, SHAPE_IDS)).toEqual([]);
  });

  it('has no duplicate ids, and exposes every id through shapeById', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const shape of SHAPES) {
      if (seen.has(shape.id)) duplicates.push(shape.id);
      seen.add(shape.id);
      expect(shapeById(shape.id)?.label).toBe(shape.label);
    }
    expect(duplicates).toEqual([]);
    expect(SHAPE_IDS.size).toBe(SHAPES.length);
    expect(shapeById('no.such.shape')).toBeUndefined();
  });
});

function familyExplains(shape: ShapeDeclaration): boolean {
  return (
    (shape.id.startsWith('decoy.') && shape.emission === 'declined') ||
    (shape.id.startsWith('unread.') && shape.emission === 'gap') ||
    (shape.id.startsWith('path.') && shape.emission === 'declined')
  );
}

/**
 * Emission classes whose rows read backwards: a zero is correct and a non-zero is the
 * failure. `declined` means the text is not a live path; `unclaimed` means a real file the
 * engine chooses not to index, a scope decision rather than a defect.
 */
const BACKWARD_READING: readonly string[] = ['declined', 'unclaimed'];

// Each case builds its own damaged pair rather than editing shared state, so no case can
// stop firing because something elsewhere changed.
describe('the reconciliation is proved able to fail', () => {
  const BASE = ['html.img.src', 'css.url.bare'];
  const counts = new Map<string, number>([
    ['html.img.src', 3],
    ['css.url.bare', 3],
  ]);

  it('goes red when the TREE declares a shape the engine does not', () => {
    const problems = reconcile({
      engineIds: BASE,
      treeIds: [...BASE, 'html.picture.newthing'],
      growthList: [],
      treeCounts: counts,
    });

    expect(problems).toEqual([{ direction: 'missing-here', id: 'html.picture.newthing' }]);
  });

  it('goes red when the ENGINE declares a shape the tree does not', () => {
    const problems = reconcile({
      engineIds: [...BASE, 'js.invented.shape'],
      treeIds: BASE,
      growthList: [],
      treeCounts: counts,
    });

    expect(problems).toEqual([{ direction: 'missing-in-tree', id: 'js.invented.shape' }]);
  });

  it('stays green for an engine-only shape that is ON the growth list', () => {
    const problems = reconcile({
      engineIds: [...BASE, 'js.new-url'],
      treeIds: BASE,
      growthList: ['js.new-url'],
      treeCounts: counts,
    });

    expect(problems).toEqual([]);
  });

  it('goes red when a growth-list shape gains tree instances and nobody removed it', () => {
    // The tree gained coverage, but the growth list still calls the shape untested. Left
    // unchecked, the matrix would keep printing a debt that is settled.
    const problems = reconcile({
      engineIds: [...BASE, 'js.new-url'],
      treeIds: [...BASE, 'js.new-url'],
      growthList: ['js.new-url'],
      treeCounts: new Map([...counts, ['js.new-url', 4]]),
    });

    expect(problems).toEqual([{ direction: 'growth-list-now-tested', id: 'js.new-url' }]);
  });

  describe('the adapterEmitsAs check is proved able to fail', () => {
    const KNOWN = new Set(['a.real.shape', 'another.real.shape']);
    const declare = (over: Partial<ShapeDeclaration>): ShapeDeclaration => ({
      id: 'a.real.shape',
      label: 'a shape',
      spec: '4a',
      emission: 'engine',
      ...over,
    });

    it('goes red when adapterEmitsAs names a shape that does not exist', () => {
      // The rot an exemption list cannot report: a shape was renamed and the exemption
      // kept pointing at the old id, still suppressing.
      const problems = auditEmitsAs(
        [declare({ adapterEmitsAs: ['gone.away'], needsToSee: 'the disk' })],
        KNOWN,
      );

      expect(problems).toEqual([
        'a.real.shape: adapterEmitsAs names gone.away, which is not a shape',
      ]);
    });

    it('goes red when adapterEmitsAs names ITSELF', () => {
      // Self-reference would make the shape permanently excused from its own row.
      const problems = auditEmitsAs(
        [declare({ adapterEmitsAs: ['a.real.shape'], needsToSee: 'the disk' })],
        KNOWN,
      );

      expect(problems).toEqual(['a.real.shape: adapterEmitsAs names itself']);
    });

    it('goes red when the exemption does not say what the adapter cannot see', () => {
      const problems = auditEmitsAs([declare({ adapterEmitsAs: ['another.real.shape'] })], KNOWN);

      expect(problems).toEqual([
        'a.real.shape: adapterEmitsAs without needsToSee naming the resolver fact',
      ]);
    });

    it('goes red on an empty list, which would read as an exemption and grant none', () => {
      const problems = auditEmitsAs(
        [declare({ adapterEmitsAs: [], needsToSee: 'the disk' })],
        KNOWN,
      );

      expect(problems).toEqual(['a.real.shape: adapterEmitsAs is empty']);
    });

    it('goes red on a needsToSee with no adapterEmitsAs behind it', () => {
      const problems = auditEmitsAs([declare({ needsToSee: 'the disk' })], KNOWN);

      expect(problems).toEqual(['a.real.shape: has needsToSee but no adapterEmitsAs']);
    });

    it('stays green for a shape that declares neither, which is most of them', () => {
      expect(auditEmitsAs([declare({})], KNOWN)).toEqual([]);
    });

    it('stays green for a correctly declared exemption', () => {
      const problems = auditEmitsAs(
        [declare({ adapterEmitsAs: ['another.real.shape'], needsToSee: 'the paths table' })],
        KNOWN,
      );

      expect(problems).toEqual([]);
    });
  });

  it('reports BOTH directions at once rather than stopping at the first', () => {
    const problems = reconcile({
      engineIds: [...BASE, 'js.invented.shape'],
      treeIds: [...BASE, 'html.picture.newthing'],
      growthList: [],
      treeCounts: counts,
    });

    expect(problems).toHaveLength(2);
    expect(problems.map((p) => p.direction).sort()).toEqual(['missing-here', 'missing-in-tree']);
  });
});
