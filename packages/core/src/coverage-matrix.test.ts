/**
 * The measuring harness, proved able to fail.
 *
 * 🔴 **A MEASURING INSTRUMENT NOBODY HAS SEEN FAIL IS THE FIFTH GUARD THAT NEVER FIRES.**
 * This project has shipped four, and the coverage tree's own `prove-can-fail.mjs` exists
 * because its author reached the same conclusion about the key's integrity check. The
 * matrix is worse than those if it is wrong, because its output is a table people quote
 * decisions from.
 *
 * ⚠️ **Every case BUILDS the condition it tests** — its own key, its own observations —
 * rather than leaning on the real tree. That is R78's lesson, and it cost two mutation
 * cases: both depended on an `UNDECIDED` entry existing, a ruling removed the last one,
 * and one case crashed while the other went GREEN ON DAMAGE. A proof that depends on the
 * state of the thing it proves is the same defect as a guard that has never fired.
 *
 * The arithmetic lives in `coverage-tree/tools/matrix.mjs`, which imports nothing at all
 * — not the engine, not `node:fs`. That purity is what makes this file possible.
 */

import { describe, expect, it } from 'vitest';
// A plain .mjs instrument, deliberately outside the package's source tree — it measures
// the engine and must not ship inside it. `matrix.d.mts` beside it is the seam, and it
// exists because a `@ts-expect-error` here did not survive the formatter reflowing the
// import: the directive stopped applying to the line that errors, then failed as unused
// while the real error came back.
import {
  ACCEPTS,
  type MatrixFinding,
  type MatrixResult,
  type MatrixRow,
  NON_DEFECT_KINDS,
  type ShapeDisagreement,
  buildMatrix,
  renderMatrix,
} from '../../../coverage-tree/tools/matrix.mjs';

interface Entry {
  raw: string;
  occurrence: number;
  shape: string;
  expect: string;
  offset: number;
  line: number;
  knownGap?: string;
}

/** One keyed file with one entry, which is all most cases need. */
function keyWith(entry: Partial<Entry>) {
  return {
    files: [
      {
        path: 'a/one.html',
        entries: [
          {
            raw: '/img/hero.png',
            occurrence: 1,
            shape: 'html.img.src',
            expect: 'resolved',
            offset: 10,
            line: 1,
            ...entry,
          },
        ],
      },
    ],
  };
}

/** What the engine was seen to do in that file. */
function observed(
  references: { start: number; shape?: string; resolution: string; rawPath?: string }[],
  threw: string | null = null,
) {
  return new Map([
    [
      'a/one.html',
      {
        path: 'a/one.html',
        threw,
        references: references.map((reference) => ({
          shape: 'html.img.src',
          rawPath: '/img/hero.png',
          ...reference,
        })),
      },
    ],
  ]);
}

/**
 * The row for one shape, or a loud failure.
 *
 * ⚠️ It threw a hand-written structural type and a double cast until `matrix.d.mts`
 * existed, and the cast is what made that survivable — `as unknown as {…}` would have let
 * a missing row through as `undefined` and `toMatchObject` say nothing useful about it.
 * Rule 17's shape: typechecking the tests caught the fixture, not the code.
 */
function rowOf(result: MatrixResult, shape: string): MatrixRow {
  const row = result.rows.find((candidate) => candidate.shape === shape);
  if (row === undefined) throw new Error(`the matrix has no row for ${shape}`);
  return row;
}

/** The first finding, or a loud failure — an empty list must not read as a pass. */
function firstFinding(result: MatrixResult): MatrixFinding {
  const [first] = result.findings;
  if (first === undefined) throw new Error('expected at least one finding, and there were none');
  return first;
}

/** The only shape disagreement, or a loud failure. Same reason as `firstFinding`. */
function onlyDisagreement(result: MatrixResult): ShapeDisagreement {
  const [first, ...rest] = result.shapeDisagreements;
  if (first === undefined) throw new Error('expected one shape disagreement, and there were none');
  if (rest.length > 0) throw new Error(`expected one shape disagreement, got ${rest.length + 1}`);
  return first;
}

describe('the matrix counts an outcome the way the key defines it', () => {
  it('counts a matching outcome as met', () => {
    const result = buildMatrix(keyWith({}), observed([{ start: 10, resolution: 'resolved' }]));

    expect(rowOf(result, 'html.img.src')).toMatchObject({ expected: 1, met: 1, missed: 0 });
    expect(result.findings).toEqual([]);
  });

  it('🔴 counts a DIFFERENT outcome as a miss, and says which way round', () => {
    const result = buildMatrix(keyWith({}), observed([{ start: 10, resolution: 'broken' }]));

    expect(rowOf(result, 'html.img.src')).toMatchObject({ met: 0, missed: 1 });
    expect(firstFinding(result)).toMatchObject({ kind: 'wrong-outcome' });
    expect(firstFinding(result).detail).toContain('expected resolved, engine said broken');
  });

  it('🔴 counts silence as a miss where the expect does not allow silence', () => {
    // The regression R75 names: a refactor dropping srcset from 9 to 5. Nothing in the
    // engine's own output would say so — the references are simply not there.
    const result = buildMatrix(keyWith({}), observed([]));

    expect(rowOf(result, 'html.img.src')).toMatchObject({ met: 0, missed: 1 });
    expect(firstFinding(result).detail).toContain('engine said absent');
  });

  it('joins on POSITION, so a right answer at the wrong offset is still a miss', () => {
    // Offsets are the whole point of the key: a reference found one byte along is a
    // rewrite that lands in the wrong place.
    const result = buildMatrix(keyWith({}), observed([{ start: 11, resolution: 'resolved' }]));

    expect(rowOf(result, 'html.img.src')).toMatchObject({ met: 0, missed: 1 });
  });
});

describe('the two expects that accept SILENCE as well as an outcome', () => {
  // The key's own `expectSemantics` records that these were written as situations
  // rather than as behaviours, and that 12 entries would otherwise read as misses for
  // correct behaviour. Both directions are asserted, because a permissive rule that is
  // never tested for what it REFUSES is a rule that accepts everything.
  it.each([
    ['discarded', 'discarded'],
    ['out-of-scope', 'out-of-scope'],
  ])('accepts %s as either the outcome or nothing at all', (expectValue, resolution) => {
    const met = buildMatrix(
      keyWith({ expect: expectValue }),
      observed([{ start: 10, resolution }]),
    );
    const silent = buildMatrix(keyWith({ expect: expectValue }), observed([]));

    expect(rowOf(met, 'html.img.src').met).toBe(1);
    expect(rowOf(silent, 'html.img.src').met).toBe(1);
  });

  it.each([
    ['discarded', 'resolved'],
    ['discarded', 'resolved-pattern'],
    ['discarded', 'broken'],
    ['out-of-scope', 'resolved'],
    ['out-of-scope', 'resolved-pattern'],
    ['out-of-scope', 'broken'],
  ])('🔴 REFUSES %s when the engine said %s', (expectValue, resolution) => {
    // The key's sentence, made executable: "it must NOT accept a resolved, broken or
    // rewritten outcome". A refusal row that accepted `resolved` would be scoring a
    // false positive as a pass, which is the failure class this product exists around.
    const result = buildMatrix(
      keyWith({ expect: expectValue }),
      observed([{ start: 10, resolution }]),
    );

    expect(rowOf(result, 'html.img.src')).toMatchObject({ met: 0, missed: 1 });
  });

  it('has an ACCEPTS table covering every expect value the key uses', () => {
    // Without this, a new outcome added to the union would silently fall to `[]` and
    // every entry carrying it would read as a miss — a whole row wrong for a reason
    // that is not the engine's.
    expect(Object.keys(ACCEPTS).sort()).toEqual([
      'broken',
      'discarded',
      'dynamic',
      'out-of-scope',
      'resolved',
      'resolved-pattern',
      'unresolved-alias',
    ]);
  });
});

describe('R86 — a throw is a THIRD outcome, never merged into a refusal', () => {
  it('🔴 does NOT let a crashed file satisfy a `discarded` row', () => {
    // THE CASE R86 WAS RULED FOR. `discarded` accepts silence, and a crashed adapter
    // produces silence — so without the separation this row would read as a pass for a
    // file the engine could not read at all. That is R20's shape inside the instrument
    // built to measure it.
    const result = buildMatrix(
      keyWith({ expect: 'discarded' }),
      observed([], 'parse-failed: invalid css syntax'),
    );

    expect(rowOf(result, 'html.img.src')).toMatchObject({ met: 0, threw: 1 });
    expect(firstFinding(result).detail).toContain('invalid css syntax');
  });

  it('names a throw where silence was right as NOTED, not as a defect (R90)', () => {
    // 🔴 R86 AND R90 MEET HERE. R86: never merge a throw into a refusal, because the two
    // silences mean opposite things. R90: where the key's expect ACCEPTS silence, the
    // throw is the mechanism by which the right thing happened. `entity.html`'s four
    // swallowed entries are exactly this — the file cannot be parsed and a browser
    // renders nothing there either. So it stays visible in the `threw` column and is
    // reported under its own kind, and the run does not fail on it.
    const result = buildMatrix(
      keyWith({ expect: 'discarded' }),
      observed([], 'parse-failed: unclosed <style>'),
    );

    expect(firstFinding(result).kind).toBe('threw-expected-silence');
    expect(NON_DEFECT_KINDS).toContain('threw-expected-silence');
  });

  it('🔴 but a throw where a REFERENCE was expected stays a defect', () => {
    // The control, and without it the case above would pass with every throw excused.
    const result = buildMatrix(keyWith({ expect: 'resolved' }), observed([], 'parse-failed: x'));

    expect(firstFinding(result).kind).toBe('threw');
    expect(NON_DEFECT_KINDS).not.toContain('threw');
  });

  it('names the throw rather than counting it as an ordinary miss', () => {
    const result = buildMatrix(keyWith({}), observed([], 'unreadable: ENOENT'));

    expect(rowOf(result, 'html.img.src')).toMatchObject({ missed: 0, threw: 1 });
  });

  it('🔴 still credits a PARTIAL reference the throw carried with it', () => {
    // R20's fix is that a throw carries the references already collected, so a file can
    // be both partly measured and recorded unscanned. Checking `threw` first credited
    // such a file with nothing — which would also have hidden whether that fix works.
    const result = buildMatrix(
      keyWith({}),
      observed([{ start: 10, resolution: 'resolved' }], 'parse-failed: later in the file'),
    );

    expect(rowOf(result, 'html.img.src')).toMatchObject({ met: 1, threw: 0 });
  });

  it('reports a file it never measured instead of skipping it', () => {
    // A group missing from the observations is not evidence of anything. Silently
    // dropping it is how a matrix reads green over work it never did.
    const result = buildMatrix(keyWith({}), new Map());

    expect(rowOf(result, 'html.img.src')).toMatchObject({ expected: 1, met: 0, missed: 1 });
    expect(firstFinding(result)).toMatchObject({ kind: 'not-observed' });
  });
});

describe('a knownGap is a sanctioned divergence, and a settled one is a defect', () => {
  it('counts a diverging entry that carries a knownGap as a gap, not a miss', () => {
    const result = buildMatrix(
      keyWith({ knownGap: 'R85: no reader yet' }),
      observed([{ start: 10, resolution: 'broken' }]),
    );

    expect(rowOf(result, 'html.img.src')).toMatchObject({ met: 0, missed: 0, knownGap: 1 });
    expect(result.findings).toEqual([]);
  });

  it('🔴 reports a knownGap whose entry now AGREES — the debt was settled', () => {
    // Same hazard as a growth-list shape that quietly gained coverage: a record of a
    // debt nobody settles goes on being printed as a debt, and a reader learns to
    // discount the column. Found five of these on the first real run.
    const result = buildMatrix(
      keyWith({ knownGap: 'aliases are not resolved yet' }),
      observed([{ start: 10, resolution: 'resolved' }]),
    );

    expect(rowOf(result, 'html.img.src')).toMatchObject({ staleGap: 1, knownGap: 0 });
    expect(firstFinding(result)).toMatchObject({ kind: 'stale-known-gap' });
  });
});

describe('it joins in BOTH directions', () => {
  it('🔴 reports a reference the engine claimed where the key lists nothing', () => {
    // The direction B7's probe could not see at all, and the more dangerous of the two:
    // a miss is a gap in coverage, an unkeyed claim is the engine asserting something
    // nobody sanctioned — and `--replace` rewrites what the engine asserts.
    const result = buildMatrix(
      keyWith({}),
      observed([
        { start: 10, resolution: 'resolved' },
        { start: 400, resolution: 'resolved', rawPath: '/img/nobody-keyed-this.png' },
      ]),
    );

    expect(result.unkeyed).toHaveLength(1);
    expect(result.unkeyed[0]).toMatchObject({ start: 400, rawPath: '/img/nobody-keyed-this.png' });
  });

  it('does not report an unkeyed reference the engine refused anyway', () => {
    // A `discarded` guess at an unkeyed offset is not a claim. Counting those would bury
    // the real signal under a list a reader learns to ignore — R75's objection, one
    // level up from the row it was written about.
    const result = buildMatrix(
      keyWith({}),
      observed([
        { start: 10, resolution: 'resolved' },
        { start: 400, resolution: 'discarded' },
      ]),
    );

    expect(result.unkeyed).toEqual([]);
  });
});

describe('R87 — a shape disagreement is a defect only where no layer is declared', () => {
  const key = keyWith({ shape: 'decoy.typo', expect: 'discarded' });
  const seen = observed([{ start: 10, shape: 'js.string.literal', resolution: 'discarded' }]);

  it('explains a disagreement the key shape declares an adapterEmitsAs for', () => {
    const result = buildMatrix(key, seen, {
      declarationOf: (id: string) =>
        id === 'decoy.typo' ? { adapterEmitsAs: ['js.string.literal'] } : undefined,
    });

    expect(result.shapeDisagreements).toHaveLength(1);
    expect(onlyDisagreement(result).explained).toBe(true);
  });

  it('🔴 does NOT explain it when the declaration names a different shape', () => {
    // The rot an exemption list cannot report. A declaration that no longer matches what
    // the adapter emits must stop excusing it.
    const result = buildMatrix(key, seen, {
      declarationOf: () => ({ adapterEmitsAs: ['md.raw-html'] }),
    });

    expect(onlyDisagreement(result).explained).toBe(false);
  });

  it('does not explain it when nothing is declared at all', () => {
    const result = buildMatrix(key, seen, { declarationOf: () => undefined });

    expect(onlyDisagreement(result).explained).toBe(false);
  });
});

describe('the rendering', () => {
  const result = buildMatrix(keyWith({}), observed([{ start: 10, resolution: 'resolved' }]));

  it('🔴 has NO TOTAL ROW (R75), and that is asserted rather than assumed', () => {
    // The matrix's whole value is being structurally unquotable: with no single number
    // there is nothing to escape into a README. A later hand adding a convenient total
    // would dissolve that in one line, so the absence is a test.
    const rendered = renderMatrix(result).toLowerCase();

    expect(rendered).not.toMatch(/^\s*total/m);
    expect(rendered).not.toContain('overall');
    expect(rendered).not.toMatch(/\d+\s*%/);
  });

  it('states what the instrument cannot tell you, in the output itself', () => {
    // Including the one that matters most: it cannot see a defect both instruments
    // share. R80(a) sat inside that blind spot for a day.
    const rendered = renderMatrix(result);

    expect(rendered).toContain('CLASSIFICATION defect');
    expect(rendered).toContain('cannot tell you');
  });

  it('marks a refusal row as reading backwards', () => {
    const rendered = renderMatrix(result, { emissionOf: () => 'declined' });

    expect(rendered).toContain('a MISS here means the engine claimed it');
  });
});
