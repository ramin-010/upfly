/**
 * Tests for the coverage matrix (`coverage-tree/tools/matrix.mjs`), written to show that its
 * checks can fail: decisions are made from the matrix's table, and a check nobody has seen
 * fail proves nothing. See "Reference shapes" in ARCHITECTURE.md.
 *
 * Every case builds its own key and observations rather than reading the real tree, so a
 * change to the tree cannot leave a case passing without testing anything. `matrix.mjs`
 * imports nothing, not even `node:fs`, which is what lets a test feed it any input.
 */

import { describe, expect, it } from 'vitest';
// A plain `.mjs` tool kept outside the package, since it measures the engine and must not
// ship with it. `matrix.d.mts` beside it supplies the types.
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
  /** Which mechanism this entry's gap names, when it names one. */
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

/** The row for one shape, or a loud failure naming the shape. */
function rowOf(result: MatrixResult, shape: string): MatrixRow {
  const row = result.rows.find((candidate) => candidate.shape === shape);
  if (row === undefined) throw new Error(`the matrix has no row for ${shape}`);
  return row;
}

/** The first finding, or a loud failure: an empty list must not read as a pass. */
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
    // A refactor that stops finding some `srcset` candidates leaves nothing in the engine's
    // own output to say so: the references are simply not there.
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
  // The key's `expectSemantics` defines these two as situations rather than behaviours, so
  // an entry is met by the outcome or by no reference at all. Both directions are tested:
  // a permissive rule never tested for what it refuses accepts everything.
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
    // A refusal row that accepted `resolved` would count a false positive, the dangerous
    // failure, as a pass.
    const result = buildMatrix(
      keyWith({ expect: expectValue }),
      observed([{ start: 10, resolution }]),
    );

    expect(rowOf(result, 'html.img.src')).toMatchObject({ met: 0, missed: 1 });
  });

  it('has an ACCEPTS table covering every expect value the key uses', () => {
    // An expect value missing from `ACCEPTS` falls back to `[]`, so every entry carrying it
    // would read as a miss for a reason that is not the engine's.
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

describe('a throw is a third outcome, never merged into a refusal', () => {
  it('🔴 does NOT let a crashed file satisfy a `discarded` row', () => {
    // `discarded` accepts silence, and a crashed adapter is silent too, so without the
    // separation this row would pass for a file the engine could not read at all.
    const result = buildMatrix(
      keyWith({ expect: 'discarded' }),
      observed([], 'parse-failed: invalid css syntax'),
    );

    expect(rowOf(result, 'html.img.src')).toMatchObject({ met: 0, threw: 1 });
    expect(firstFinding(result).detail).toContain('invalid css syntax');
  });

  it('names a throw where silence was right as noted, not as a defect', () => {
    // Where the expect accepts silence, the throw brought about the right outcome, as when
    // an unclosed `<style>` swallows text a browser does not render either. It still counts
    // as `threw`, not met, but under its own kind, and the run does not fail on it.
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
    // A throw carries the references collected before it, so a file can be both partly
    // measured and recorded as unscanned. Checking `threw` first would credit such a file
    // with nothing and hide whether those references survive.
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
    // A gap the engine has closed goes on printing as a debt until someone removes it, and
    // a reader learns to discount the column.
    const result = buildMatrix(
      keyWith({ knownGap: 'aliases are not resolved yet' }),
      observed([{ start: 10, resolution: 'resolved' }]),
    );

    expect(rowOf(result, 'html.img.src')).toMatchObject({ staleGap: 1, knownGap: 0 });
    expect(firstFinding(result)).toMatchObject({ kind: 'stale-known-gap' });
  });
});

// A gap that names a mechanism, such as serving-root detection, cannot be judged by a run
// that never used it: with serving roots declared, detection does not run. Agreement is
// what retires a gap, so the first case, agreement with the mechanism switched off, is the
// one that matters.
describe('a gap can only be retired by a run that exercises the mechanism it names', () => {
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
    // guard that can only ever say no is one nobody reads.
    const result = buildMatrix(
      gapped('serving-root-detection'),
      observed([{ start: 10, resolution: 'broken' }]),
      { exercises: new Set(['serving-root-detection']) },
    );

    expect(rowOf(result, 'html.img.src')).toMatchObject({ staleGap: 1, notExercised: 0 });
    expect(firstFinding(result)).toMatchObject({ kind: 'stale-known-gap' });
  });

  it('leaves a gap with no declared mechanism to the ordinary rule', () => {
    // Most of the key's gaps name no mechanism. They keep the ordinary rule, or none of them
    // could ever be retired.
    const result = buildMatrix(
      keyWith({ knownGap: 'no reader yet' }),
      observed([{ start: 10, resolution: 'resolved' }]),
      { exercises: new Set() },
    );

    expect(rowOf(result, 'html.img.src')).toMatchObject({ staleGap: 1, notExercised: 0 });
  });

  it('🔴 is NOT counted as a defect, but IS printed under its own heading', () => {
    // Failing on it would keep red every run that leaves the mechanism out on purpose, and
    // a check that is always red gets ignored. So it is printed, in words rather than only
    // as a column of zeroes.
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
    // A typo matches nothing in `exercises`, so the entry would become a gap nobody can
    // retire, and it would read as caution. This mistake and the next both fail in the
    // direction that looks fine, which is why they throw instead of adding a row.
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

  // `observedUnder` supplies a separate run made with the mechanism switched on. An entry
  // naming that mechanism is judged on that run, never on the main run that happens to agree.
  it("🔴 judges a gap on the mechanism's OWN run, so the declared run's agreement retires nothing", () => {
    // Declared roots say `broken`, which agrees; detection says `resolved`. Judged on the
    // declared run, the gap would read as stale merely because the mechanism is listed as
    // exercised.
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

// Each run measures one configuration. Under the key's stated serving roots, detection is
// not part of the setup, so an entry whose gap names detection is judged on its outcome:
// agreement counts as met and never retires the gap. The run that uses detection judges
// the gap.
describe('a gap in a mechanism the configuration does not use', () => {
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
    // a defect of that configuration, not a known debt.
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
    // The run that uses detection, confirming the gap. A result that pointed readers at
    // the findings would drop this miss: a `knownGap` entry is unmet and has no finding.
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
    // The more dangerous direction: a miss is a gap in coverage, but an unkeyed claim is
    // the engine asserting something nobody sanctioned, and `optimize` rewrites what the
    // engine asserts.
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
    // the real signal under a list a reader learns to ignore.
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

describe('a shape disagreement is a defect only where no layer is declared', () => {
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

  it('has no total row, and that is asserted rather than assumed', () => {
    // With no single number, there is nothing to quote out of context. A convenient total
    // would undo that in one line, so its absence is tested.
    const rendered = renderMatrix(result).toLowerCase();

    expect(rendered).not.toMatch(/^\s*total/m);
    expect(rendered).not.toContain('overall');
    expect(rendered).not.toMatch(/\d+\s*%/);
  });

  it('states what the instrument cannot tell you, in the output itself', () => {
    // Including the one that matters most: where the key and the engine agree and are both
    // wrong, it reports nothing.
    const rendered = renderMatrix(result);

    expect(rendered).toContain('CLASSIFICATION defect');
    expect(rendered).toContain('cannot tell you');
  });

  it('marks a refusal row as reading backwards', () => {
    const rendered = renderMatrix(result, { emissionOf: () => 'declined' });

    expect(rendered).toContain('a MISS here means the engine claimed it');
  });

  // `reconcile` checks the rows' arithmetic, which can close while the printed table does
  // not: a bucket with no column hides its entries from the page. These cases test the page.
  describe('the printed table, which is not the same thing as the arithmetic', () => {
    it('prints a column for every bucket an entry can land in', () => {
      const header = renderMatrix(result)
        .split('\n')
        .find((line) => line.trimStart().startsWith('shape'));
      if (header === undefined) throw new Error('the rendered table has no header row');

      for (const bucket of BUCKETS) expect(header).toContain(bucket.label);
    });

    it("🔴 says so loudly when a row's printed columns do not sum to its `exp`", () => {
      // Built by hand rather than through `buildMatrix`, because this state cannot occur
      // while `BUCKETS` is the single source. The page must still catch it if it ever does.
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
  // A table that does not add up still prints. Nothing else in the module would notice a
  // verdict counted twice or sent to a bucket that does not exist, since
  // `row[verdict.bucket] += 1` would create one.
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
    // A miss with no finding to explain it is a silent skip, the bug this tool exists to
    // find.
    const result = reconcile([row({ met: 2, missed: 1 })], keyOf(3), []);

    expect(result.closes).toBe(false);
    expect(result.problems.some((p: string) => p.includes('against 0 findings'))).toBe(true);
  });
});
