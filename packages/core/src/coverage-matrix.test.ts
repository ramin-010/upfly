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
  BUCKETS,
  type MatrixFinding,
  type MatrixResult,
  type MatrixRow,
  NON_DEFECT_KINDS,
  type ShapeDisagreement,
  buildMatrix,
  claimedPopulation,
  reconcile,
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
  /** R96: which mechanism this entry's gap names, when it names one. */
  gapMechanism?: string;
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

/**
 * 🔴 **R96 — and these cases exist because the harness DID retire a live defect.**
 *
 * Two `docs-examples/public/example.html` entries carry a gap saying *"detection climbs
 * ancestors looking for a directory named `public` and will wrongly resolve this"*.
 * `measure.mjs` feeds the key's DECLARED roots, so detection never ran; both entries came
 * out `broken`, matched their `expect`, and printed **"the gap is closed"**. Probed against
 * `detectServingRoots` the same day: it claims `docs-examples/public` and resolves both.
 * The defect is entirely live and the record of it was one commit from deletion.
 *
 * ⚠️ **The first case below is the one that matters, and it is the agreement case.** A
 * mismatch was always going to stay a gap; it is AGREEMENT that retires one, so agreement
 * reached with the mechanism switched off is the whole bug.
 */
describe('R96 — a gap can only be retired by a run that exercises the mechanism it names', () => {
  const gapped = (mechanism: string) =>
    keyWith({
      expect: 'broken',
      knownGap: 'detection will climb ancestors and misresolve this',
      gapMechanism: mechanism,
    });

  it('🔴 does NOT call a gap stale when its mechanism was not exercised, even on agreement', () => {
    const result = buildMatrix(
      gapped('serving-root-detection'),
      observed([{ start: 10, resolution: 'broken' }]),
      { exercises: new Set() },
    );

    expect(rowOf(result, 'html.img.src')).toMatchObject({ staleGap: 0, notExercised: 1 });
    expect(firstFinding(result)).toMatchObject({
      kind: 'gap-not-exercised',
      gapMechanism: 'serving-root-detection',
    });
    expect(firstFinding(result).detail).toContain('which is not evidence');
  });

  it('DOES call it stale once the run exercises that mechanism', () => {
    // The other direction, so the rule is a condition rather than a blanket refusal. A
    // guard that can only ever say no is R75's row nobody reads.
    const result = buildMatrix(
      gapped('serving-root-detection'),
      observed([{ start: 10, resolution: 'broken' }]),
      { exercises: new Set(['serving-root-detection']) },
    );

    expect(rowOf(result, 'html.img.src')).toMatchObject({ staleGap: 1, notExercised: 0 });
    expect(firstFinding(result)).toMatchObject({ kind: 'stale-known-gap' });
  });

  it('leaves a gap with no declared mechanism to the ordinary rule', () => {
    // 58 of the key's entries carry a gap and only two name a mechanism. The default must
    // not change for the other 56, or R96 would quietly freeze every debt in the key.
    const result = buildMatrix(
      keyWith({ knownGap: 'no reader yet' }),
      observed([{ start: 10, resolution: 'resolved' }]),
      { exercises: new Set() },
    );

    expect(rowOf(result, 'html.img.src')).toMatchObject({ staleGap: 1, notExercised: 0 });
  });

  it('🔴 is NOT counted as a defect, but IS printed under its own heading', () => {
    // Gating on it would make the run permanently red for a configuration measure.mjs
    // chose on purpose, and a permanently-red gate is one people route around. Visible
    // instead of fatal — but visible in prose, not only as a column of zeroes.
    const result = buildMatrix(
      gapped('serving-root-detection'),
      observed([{ start: 10, resolution: 'broken' }]),
    );
    const rendered = renderMatrix(result);

    expect(NON_DEFECT_KINDS).toContain('gap-not-exercised');
    expect(rendered).toContain('NOT EXERCISED by this run');
    expect(rendered).toContain('serving-root-detection');
  });

  it('🔴 THROWS on a gapMechanism outside the vocabulary, rather than freezing the entry', () => {
    // A typo matches nothing in `exercises`, so the entry becomes a gap nobody can ever
    // retire — and it reads as caution. Both mistakes here fail in the direction that
    // looks fine, which is why this is a throw and not a row.
    expect(() =>
      buildMatrix(
        gapped('serving-root-detektion'),
        observed([{ start: 10, resolution: 'broken' }]),
      ),
    ).toThrow(/unknown gap mechanism/);
  });

  it('🔴 THROWS when the CALLER claims a mechanism that does not exist', () => {
    // The mirror: a misspelled `exercises` entry matches no gap, so the run silently
    // claims less than it does and every affected gap stays frozen.
    expect(() =>
      buildMatrix(
        gapped('serving-root-detection'),
        observed([{ start: 10, resolution: 'broken' }]),
        {
          exercises: new Set(['srving-root-detection']),
        },
      ),
    ).toThrow(/caller claims to exercise/);
  });

  it('🔴 THROWS on a gapMechanism with no knownGap to retire', () => {
    expect(() =>
      buildMatrix(
        keyWith({ gapMechanism: 'serving-root-detection' }),
        observed([{ start: 10, resolution: 'resolved' }]),
      ),
    ).toThrow(/no knownGap/);
  });

  /**
   * R167 group E: `measure.mjs` now RUNS detection, as a second resolution beside the
   * declared one, and hands it over as `observedUnder`. These pin that an entry naming the
   * mechanism is judged on that run — and never on the declared run that happens to agree.
   */
  it("🔴 judges a gap on the mechanism's OWN run, so the declared run's agreement retires nothing", () => {
    // The exact trap: declared roots say `broken` (agrees), detection says `resolved`.
    // Judged on the declared run this would read "stale" — R96's original bug, re-armed by
    // merely listing the mechanism as exercised.
    const result = buildMatrix(
      gapped('serving-root-detection'),
      observed([{ start: 10, resolution: 'broken' }]),
      {
        exercises: new Set(['serving-root-detection']),
        observedUnder: {
          'serving-root-detection': observed([{ start: 10, resolution: 'resolved' }]),
        },
      },
    );

    expect(rowOf(result, 'html.img.src')).toMatchObject({
      knownGap: 1,
      staleGap: 0,
      notExercised: 0,
    });
  });

  it("retires the gap when the mechanism's own run agrees — the other direction", () => {
    const result = buildMatrix(
      gapped('serving-root-detection'),
      observed([{ start: 10, resolution: 'resolved' }]),
      {
        exercises: new Set(['serving-root-detection']),
        observedUnder: {
          'serving-root-detection': observed([{ start: 10, resolution: 'broken' }]),
        },
      },
    );

    expect(rowOf(result, 'html.img.src')).toMatchObject({ staleGap: 1, knownGap: 0 });
  });

  it('🔴 THROWS when a run is supplied for a mechanism the caller does not claim', () => {
    expect(() =>
      buildMatrix(
        gapped('serving-root-detection'),
        observed([{ start: 10, resolution: 'broken' }]),
        {
          observedUnder: {
            'serving-root-detection': observed([{ start: 10, resolution: 'broken' }]),
          },
        },
      ),
    ).toThrow(/does not claim to exercise/);
  });
});

/**
 * R179 — two published numbers, each measuring ONE configuration. Under the key's stated
 * serving roots, detection is not part of the setup at all, so a gap in detection says
 * nothing about what that setup produced: the entry is judged on its outcome. The run that
 * uses detection judges the gap. These pin both halves, and the one thing R96 forbids —
 * agreement retiring a gap — staying forbidden.
 */
describe('R179 — a gap in a mechanism the configuration does not use', () => {
  const gapped = keyWith({
    expect: 'broken',
    knownGap: 'detection claims a directory named public that serves nothing',
    gapMechanism: 'serving-root-detection',
  });
  const outside = { outOfConfiguration: new Set(['serving-root-detection']) };

  it('🔴 judges the entry on its outcome — agreement is MET, and never a retired gap', () => {
    const result = buildMatrix(gapped, observed([{ start: 10, resolution: 'broken' }]), outside);

    expect(rowOf(result, 'html.img.src')).toMatchObject({
      met: 1,
      staleGap: 0,
      notExercised: 0,
      knownGap: 0,
    });
    expect(result.findings).toEqual([]);
    expect(result.outOfConfiguration).toEqual([
      expect.objectContaining({ gapMechanism: 'serving-root-detection', bucket: 'met' }),
    ]);
  });

  it('reads a disagreement there as a plain miss, because the gap does not explain it', () => {
    // Under the stated configuration the detection gap cannot fire, so a wrong outcome is
    // a defect of that configuration — never parked as a known debt.
    const result = buildMatrix(gapped, observed([{ start: 10, resolution: 'resolved' }]), outside);

    expect(rowOf(result, 'html.img.src')).toMatchObject({ missed: 1, knownGap: 0 });
    expect(firstFinding(result)).toMatchObject({ kind: 'wrong-outcome' });
    expect(firstFinding(result).detail).toContain('the gap does not explain it');
  });

  it('says on the page which entries it judged that way, so `met` is not read as closure', () => {
    const rendered = renderMatrix(
      buildMatrix(gapped, observed([{ start: 10, resolution: 'broken' }]), outside),
    );

    expect(rendered).toContain('this configuration does not use (serving-root-detection)');
    expect(rendered).toContain('neither confirmed nor retired here');
  });

  it('🔴 THROWS when one mechanism is claimed as exercised AND outside the configuration', () => {
    // Both at once would judge a gap on its outcome and retire it in the same call.
    expect(() =>
      buildMatrix(gapped, observed([{ start: 10, resolution: 'broken' }]), {
        exercises: new Set(['serving-root-detection']),
        outOfConfiguration: new Set(['serving-root-detection']),
      }),
    ).toThrow(/cannot be both/);
  });

  it('🔴 names every claimed entry a run did not meet — a knownGap one too, which has no finding', () => {
    // The run that USES detection, confirming the gap. A result that pointed readers at
    // the findings would drop exactly this miss: a `knownGap` entry is unmet and silent.
    const result = buildMatrix(gapped, observed([{ start: 10, resolution: 'resolved' }]), {
      exercises: new Set(['serving-root-detection']),
    });
    const claimed = claimedPopulation(result);

    expect(result.findings).toEqual([]);
    expect(claimed).toMatchObject({ met: 0, expected: 1 });
    expect(claimed.misses).toEqual([
      expect.objectContaining({
        file: 'a/one.html',
        bucket: 'knownGap',
        keyGap: expect.stringContaining('detection claims'),
      }),
    ]);
  });

  it('🔴 THROWS on an out-of-configuration mechanism outside the vocabulary', () => {
    expect(() =>
      buildMatrix(gapped, observed([{ start: 10, resolution: 'broken' }]), {
        outOfConfiguration: new Set(['serving-root-detektion']),
      }),
    ).toThrow(/outside its configuration/);
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

  /**
   * 🔴 **THE CHECK VERIFIED THE DATA STRUCTURE AND NOTHING VERIFIED THE RENDERING.**
   *
   * `reconcile` summed six buckets and `rowTable` printed five, dropping `staleGap` from a
   * column headed `gap`. Seven entries vanished between the two — `html.img.src` printed
   * `27/29 miss 0`, `js.import.alias.mapped` printed `0/5 miss 0` — while the arithmetic
   * line said ✅ every run, because the arithmetic really did close where it was checked.
   * The comment twenty lines above the bug already said *"a table that does not add up
   * still prints, and it prints confidently"*.
   *
   * ⚠️ These assert the PAGE, which is the surface the earlier proofs could not reach.
   */
  describe('the printed table, which is not the same thing as the arithmetic', () => {
    it('prints a column for every bucket an entry can land in', () => {
      const header = renderMatrix(result)
        .split('\n')
        .find((line) => line.trimStart().startsWith('shape'));
      if (header === undefined) throw new Error('the rendered table has no header row');

      for (const bucket of BUCKETS) expect(header).toContain(bucket.label);
    });

    it("🔴 says so loudly when a row's printed columns do not sum to its `exp`", () => {
      // Built by hand rather than through buildMatrix: this is the state that cannot occur
      // while BUCKETS is the single source, and the point is that the PAGE would catch it
      // if it ever did. A proof that can only run through the happy path proves nothing.
      const damaged = {
        ...result,
        rows: [{ ...rowOf(result, 'html.img.src'), expected: 9 }],
      } as MatrixResult;

      const rendered = renderMatrix(damaged);

      expect(rendered).toContain('DO NOT SUM TO `exp`');
      expect(rendered).toContain('html.img.src');
    });

    it('stays quiet when every row balances', () => {
      // The other direction. A warning that is always on is a warning nobody reads.
      expect(renderMatrix(result)).not.toContain('DO NOT SUM TO');
    });
  });
});

describe("the matrix's own arithmetic, proved able to fail", () => {
  // 🔴 A TABLE THAT DOES NOT ADD UP STILL PRINTS, AND IT PRINTS CONFIDENTLY. Nothing else
  // in the module would notice a verdict double-counting or naming a bucket that does not
  // exist — `row[verdict.bucket] += 1` would cheerfully create one.
  //
  // ⚠️ And this check exists because I first tried to verify it from OUTSIDE by parsing
  // the rendered table. The regex silently matched only the rows without a direction
  // label and reported a one-entry discrepancy that was entirely my parser's. An
  // instrument verifiable only by scraping its own output is one nobody verifies twice.
  const row = (over: Partial<MatrixRow>): MatrixRow => ({
    shape: 'html.img.src',
    expected: 3,
    met: 3,
    missed: 0,
    threw: 0,
    knownGap: 0,
    staleGap: 0,
    notExercised: 0,
    ...over,
  });
  const keyOf = (entries: number) => ({ files: [{ entries: Array.from({ length: entries }) }] });

  it('closes on a well-formed set of rows', () => {
    expect(reconcile([row({})], keyOf(3), []).closes).toBe(true);
  });

  it('🔴 goes red when a row loses an entry between its buckets', () => {
    const result = reconcile([row({ met: 2 })], keyOf(3), []);

    expect(result.closes).toBe(false);
    expect(result.problems[0]).toContain('buckets sum to 2, expected 3');
  });

  it('🔴 goes red when a row double-counts one', () => {
    const result = reconcile([row({ met: 3, missed: 1 })], keyOf(3), []);

    expect(result.closes).toBe(false);
  });

  it('🔴 goes red when the rows do not account for every key entry', () => {
    // The failure mode that matters most: a file group silently skipped. The rows all add
    // up individually and the table reads fine.
    const result = reconcile([row({})], keyOf(9), []);

    expect(result.closes).toBe(false);
    expect(result.problems[0]).toContain('account for 3 entries, the key holds 9');
  });

  it('🔴 goes red when a non-met entry produced no finding', () => {
    // A miss with nothing to read about it is the silent-skip shape (rule 9) inside the
    // instrument built to find silent skips.
    const result = reconcile([row({ met: 2, missed: 1 })], keyOf(3), []);

    expect(result.closes).toBe(false);
    expect(result.problems.some((p: string) => p.includes('against 0 findings'))).toBe(true);
  });
});
