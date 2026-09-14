/**
 * The shape vocabulary and the coverage tree's must not drift apart.
 *
 * 🔴 **This test is the ONLY thing making two physical copies one logical list.**
 * `coverage-tree/tools/check-key.mjs` fails its own run if it imports anything outside
 * `node:` and `./` — that isolation is what stops the answer key being certified by the
 * engine it exists to measure (R72) — so it cannot import `shapes.ts`, and `shapes.ts`
 * must not import the key, because a shipping package cannot depend on a test fixture.
 *
 * Two copies with no check is 6a-decies: two implementations of one idea that nobody
 * reconciles. Two copies with a test that fails in BOTH DIRECTIONS is a different thing
 * — divergence stops being a convention and becomes a red build.
 *
 * ⚠️ **Both directions, and that is not symmetry for its own sake.** A shape added to
 * the engine and not the tree is an untested construct; a shape added to the tree and
 * not the engine is a row the matrix can never fill. They are different defects and a
 * one-way check would catch only one of them.
 *
 * ## Why the comparison is a pure function
 *
 * 🔴 **A reconciliation that has only ever been seen passing is not known to work** —
 * this project has shipped four guards that never fired. So `reconcile` takes its two
 * lists as ARGUMENTS, and the proofs below hand it deliberately damaged ones. Each proof
 * INTRODUCES the condition it tests rather than assuming some state exists: that is the
 * rule R78 cost us, when two mutation cases quietly stopped firing the moment the last
 * `UNDECIDED` entry was ruled away.
 *
 * Taking arguments is also what keeps the proofs honest without copying the tree. The
 * alternative — mutating `shapes.ts` and the key on disk — would need a temp copy of the
 * whole source tree, and a proof that writes to the real key is the hazard the tree's
 * own README names first.
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
 * `growthList` is the one sanctioned asymmetry: constructs an adapter emits that the
 * tree has no instance of. They are declared in `shapes.ts` on purpose, so the matrix
 * can print them as a debt instead of them vanishing — which is R76's whole objection
 * to leaving a shape nameless.
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
    // WITHOUT that reason and with no instances already fails check-key, so this asserts
    // the two instruments agree about which is which.
    for (const shape of key.shapes.filter((s) => s.absent !== undefined)) {
      expect(
        counts.get(shape.id) ?? 0,
        `${shape.id} is declared absent but the key has instances of it`,
      ).toBe(0);
    }
  });

  it('gives every declared shape an emission class, and a reason where it is not obvious', () => {
    // Widened deliberately: `SHAPES` is `as const` so `ShapeId` can be derived from it,
    // which also narrows every entry to its own literal type — and then `why` "does not
    // exist" on the entries that happen to lack one. The declaration type is what this
    // test reasons about.
    const declarations: readonly ShapeDeclaration[] = SHAPES;
    for (const shape of declarations) {
      expect(['engine', 'gap', 'declined'], `${shape.id}`).toContain(shape.emission);

      // A `declined` row reads BACKWARDS — a zero is correct and a non-zero is the
      // failure — so it may not be silent, UNLESS the family already says it. `decoy.*`
      // declining, `unread.*` being a gap and `path.*` declining are what those families
      // MEAN, and demanding prose there is ceremony that teaches people to write filler.
      //
      // ⚠️ The first version of this test exempted every `md.*` shape, which was not a
      // principle but a shortcut around four reasons I had not written. It hid them.
      if (shape.emission === 'declined' && !familyExplains(shape)) {
        const rule = 'A row that reads backwards has to say why.';
        expect(
          (shape.why ?? '').length > 0,
          `${shape.id} is 'declined' and its family does not explain that. ${rule}`,
        ).toBe(true);
      }
    }
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
 * 🔴 The guard, proved able to fail — in both directions and on the asymmetry it allows.
 *
 * Each case builds its own damaged pair from scratch rather than editing shared state,
 * so no case can stop firing because something elsewhere was ruled or removed.
 */
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
    // The debt was paid — somebody added tree coverage — but the growth list still calls
    // it untested. Left unchecked, the matrix would keep printing a debt that is settled.
    const problems = reconcile({
      engineIds: [...BASE, 'js.new-url'],
      treeIds: [...BASE, 'js.new-url'],
      growthList: ['js.new-url'],
      treeCounts: new Map([...counts, ['js.new-url', 4]]),
    });

    expect(problems).toEqual([{ direction: 'growth-list-now-tested', id: 'js.new-url' }]);
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
