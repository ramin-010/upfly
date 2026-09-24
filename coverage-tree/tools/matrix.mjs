/**
 * The coverage matrix: what the engine did, against what the key says a correct engine
 * should do, one row per reference shape.
 *
 * 🔴 **PURE, AND THAT IS THE DESIGN DECISION THIS FILE IS BUILT AROUND.** It imports
 * nothing — not the engine, not `node:fs` — and takes both instruments as arguments. So
 * `matrix.test.ts` can hand it a deliberately damaged pair and watch every row go the
 * wrong way, which is the only thing that makes a green matrix mean anything. This
 * project has shipped four guards that never fired; a measuring instrument nobody has
 * seen fail is the fifth waiting to happen.
 *
 * ⚠️ **It is NOT B7's audit probe grown up.** That probe is kept at
 * `notes/validation/probes/shape-audit.throwaway.mjs` as the evidence for R84 and R85
 * (R86), and inheriting a throwaway's design is R48/R49/R51's error, which this project
 * has made three times. Four things here are deliberately unlike it:
 *
 *   1. **It measures OUTCOMES, not shapes.** The probe compared `shape` against `shape`,
 *      which answers "does the engine label this the way the key does" — a real question,
 *      but not the one R75 asks. The key's `expect` is an *outcome*, so the matrix reads
 *      resolution. Shape disagreement is its own column and never a miss.
 *   2. **A THROW IS A THIRD OUTCOME (R86).** The probe wrapped `findReferences` in
 *      `catch { emitted = [] }`, making a crashing adapter indistinguishable from a
 *      correct refusal — R20's shape inside the instrument that measured the tree. Here a
 *      file the scanner could not read is a `threw` miss, named, and never merged into a
 *      refusal.
 *   3. **It joins in BOTH directions.** The probe joined on key position only, so a
 *      reference the engine emits where the key lists nothing was invisible to it.
 *   4. **NO TOTAL ROW (R75).** A single number over heterogeneous shapes is the thing
 *      that gets quoted out of context, and the matrix's whole value is being unquotable.
 *
 * ## What it cannot see, and this belongs in the report rather than in a backlog
 *
 * 🔴 **A CLASSIFICATION DEFECT IS INVISIBLE TO IT.** It joins two instruments and reports
 * where they differ. Where they AGREE and are both wrong it reports nothing — which is
 * exactly how R80(a) sat unapplied for a day: engine and key both called a partial
 * pattern `js.template.pattern`, so no join could have raised it. `blindSpots()` returns
 * this as prose so it cannot be left out of a rendering.
 */

/**
 * Which engine outcomes satisfy one `expect` value.
 *
 * 🔴 **Two of the seven accept EMITTING NOTHING as well as an outcome, and the key says so
 * in its own `expectSemantics`** — `discarded` because a `url()` in a comment is never
 * collected while a path-shaped guess that misses is collected and discarded, and
 * `out-of-scope` because an absolute URL is dropped by `isExternalUrl` before it is ever
 * a reference while a real `.mp4` becomes one the engine declines to index. ⚠️ **The key
 * records that these were written as situations rather than as behaviours, and that 12
 * entries would have read as misses for correct behaviour.** Encoding it here rather than
 * in the renderer is what stops the next instrument re-deriving it wrongly.
 *
 * `absent` is the sentinel for "the engine produced no reference at this position".
 */
export const ACCEPTS = {
  resolved: ['resolved'],
  'resolved-pattern': ['resolved-pattern'],
  dynamic: ['dynamic'],
  broken: ['broken'],
  'unresolved-alias': ['unresolved-alias'],
  // See the note above: both of these accept silence.
  discarded: ['discarded', 'absent'],
  'out-of-scope': ['out-of-scope', 'absent'],
};

/**
 * Outcomes that must NEVER satisfy `discarded` or `out-of-scope`, spelled out rather than
 * left to `ACCEPTS`' omissions.
 *
 * ⚠️ A permissive list plus silence is one typo away from accepting everything, and it
 * would accept it QUIETLY. The key's own wording is *"it must NOT accept a resolved,
 * broken or rewritten outcome"*, so that sentence is executable here and
 * `matrix.test.ts` proves it refuses each one.
 */
export const NEVER_ACCEPTABLE_AS_SILENCE = ['resolved', 'resolved-pattern', 'broken'];

/** Byte offset → UTF-16 code-unit offset (R84). The one line worth keeping from the probe. */
export function toCodeUnits(bytes, byteOffset) {
  return bytes.subarray(0, byteOffset).toString('utf8').length;
}

/**
 * Every bucket an entry can land in — **declared ONCE, and the columns are derived from
 * it.**
 *
 * 🔴 **THIS LIST EXISTS BECAUSE THE TABLE PRINTED A SUM THAT DID NOT CLOSE, AND THE
 * COMMENT TWENTY LINES BELOW ALREADY NAMED THAT EXACT FAILURE.** `reconcile` summed six
 * buckets; `rowTable` printed five, dropping `staleGap` from a column headed `gap`. Seven
 * entries vanished between the check and the page — `html.img.src` read `27/29 miss 0`,
 * `js.import.alias.mapped` read `0/5 miss 0` — and the instrument's own arithmetic line
 * said ✅ the whole time, because **the check verified the data structure and nothing
 * verified the rendering.**
 *
 * ⚠️ Fixed structurally rather than by adding the missing column: both the check and the
 * table now iterate this array, so a bucket cannot gain an entry without gaining a column.
 * A second enumeration of the same set is the defect; one more column would have been the
 * same defect waiting for the next bucket.
 *
 * `emitsFinding` is here for the same reason — `reconcile` cross-checks the bucket counts
 * against the finding list, and that pairing was a third hand-written enumeration.
 */
export const BUCKETS = Object.freeze([
  { key: 'met', label: 'met', emitsFinding: false },
  { key: 'missed', label: 'miss', emitsFinding: true },
  { key: 'threw', label: 'threw', emitsFinding: true },
  { key: 'knownGap', label: 'gap', emitsFinding: false },
  { key: 'staleGap', label: 'stale', emitsFinding: true },
  { key: 'notExercised', label: 'n/x', emitsFinding: true },
]);

/**
 * The mechanisms a `knownGap` can name, and the vocabulary a key entry may declare.
 *
 * 🔴 **R96. A GAP'S TEXT IS A SPECIFICATION OF THE INSTRUMENT THAT CAN RETIRE IT.** A gap
 * whose text says *"detection climbs ancestors looking for a directory named `public` and
 * will misresolve this"* cannot be retired by a run that feeds declared roots — detection
 * never ran. Before R96 the two `docs-examples/public/example.html` entries came out
 * `broken`, matched their `expect`, and printed **"the gap is closed"** for a defect that
 * is entirely live in the product.
 *
 * ⚠️ **This is the third variant of R86's family in two days and it is the worst of them.**
 * A throw read as a decline and a scope decision read as a defect both make the engine
 * look WORSE than it is, and someone chasing a phantom finds nothing wrong. This one makes
 * it look BETTER: it retires a live defect, and the record that would have told the next
 * reader about it is the thing that gets deleted.
 *
 * Declared per entry rather than inferred from the prose, because inferring it means
 * pattern-matching English and being wrong in the direction that deletes debts.
 */
export const GAP_MECHANISMS = Object.freeze([
  // The resolver's ancestor climb for a conventionally-named serving root. Bypassed
  // whenever a caller supplies `servingRoots.declared`, which `measure.mjs` does on
  // purpose (R92) — correct for measuring resolution, disqualifying for retiring this.
  'serving-root-detection',
]);

/**
 * Compare the two instruments.
 *
 * @param key the parsed answer key.
 * @param observed one entry per keyed file:
 *   `{ path, threw: string | null, references: [{ start, shape, resolution }] }`
 *   where `start` is a UTF-16 code-unit offset and `threw` is the reason the scanner
 *   could not read the file at all. A file absent from this map is itself a defect —
 *   reported, not skipped, because a silently missing file is how a matrix reads green
 *   over work it never did.
 * @param exercises R96: the `GAP_MECHANISMS` this run actually puts through their paces.
 *   A `knownGap` naming a mechanism outside this set can be neither confirmed nor retired
 *   by the run, and lands in `notExercised` rather than being read as closed. The default
 *   is EMPTY, which is the safe direction: a gap stays on the books until a caller states
 *   that it ran the thing the gap is about.
 * @param observedUnder `{ [mechanism]: Map }` — a SEPARATE run, made with that mechanism
 *   switched on, which is what an entry naming it is judged against. 🔴 **Without it, an
 *   entry naming an exercised mechanism is judged on `observed` — which is only honest if
 *   `observed` itself ran the mechanism.** `measure.mjs`'s main run feeds declared roots, so
 *   claiming `serving-root-detection` there and judging on the main run would read the
 *   declared run's `broken` as "the gap is closed": R96 exactly. It supplies the detection
 *   run here instead.
 */
export function buildMatrix(
  key,
  observed,
  { declarationOf = () => undefined, exercises = new Set(), observedUnder = {} } = {},
) {
  const rows = new Map();
  const findings = [];
  const rowOf = (shape) => {
    let row = rows.get(shape);
    if (row === undefined) {
      row = { shape, expected: 0 };
      for (const bucket of BUCKETS) row[bucket.key] = 0;
      rows.set(shape, row);
    }
    return row;
  };

  assertMechanismsAreDeclared(key, exercises, observedUnder);

  for (const group of key.files) {
    for (const entry of group.entries) {
      const row = rowOf(entry.shape);
      row.expected += 1;
      const run = runFor(entry, exercises, observedUnder) ?? observed;
      const verdict = classify(entry, run.get(group.path), exercises);
      row[verdict.bucket] += 1;
      if (verdict.kind !== null) {
        findings.push(finding(group, entry, verdict.kind, verdict.detail, verdict.note));
      }
    }
  }

  return {
    rows: [...rows.values()].sort((a, b) => a.shape.localeCompare(b.shape)),
    findings,
    unkeyed: unkeyedEmissions(key, observed),
    shapeDisagreements: shapeDisagreements(key, observed, declarationOf),
    arithmetic: reconcile([...rows.values()], key, findings),
  };
}

/**
 * Every `gapMechanism` the key names must be in the vocabulary, and so must every
 * mechanism the caller claims to exercise.
 *
 * 🔴 **It THROWS rather than reporting, because both mistakes fail in the direction that
 * looks fine.** A misspelled `gapMechanism` matches nothing in `exercises`, so the entry
 * becomes permanently `not exercised` — a gap nobody can ever retire, which reads as
 * caution. A misspelled `exercises` entry matches no gap, so the run silently claims less
 * than it does. Neither produces a red row; both produce a quietly wrong table, and R75's
 * first rule is that a matrix built on a broken instrument reads exactly like one that is
 * not. `measure.mjs` already refuses to run on a key/tree disagreement for the same reason.
 */
/** The separate run an entry is judged on, when its gap names a mechanism that has one. */
function runFor(entry, exercises, observedUnder) {
  if (entry.gapMechanism === undefined || !exercises.has(entry.gapMechanism)) return undefined;
  return observedUnder[entry.gapMechanism];
}

function assertMechanismsAreDeclared(key, exercises, observedUnder = {}) {
  // A run supplied for a mechanism the caller does not claim to exercise would sit there
  // looking like evidence and judge nothing — the same slip as a misspelled claim.
  for (const mechanism of Object.keys(observedUnder)) {
    if (!exercises.has(mechanism)) {
      throw new Error(
        `a run is supplied for "${mechanism}", which the caller does not claim to exercise`,
      );
    }
  }
  const known = new Set(GAP_MECHANISMS);
  const unknown = new Set();
  for (const group of key.files) {
    for (const entry of group.entries) {
      if (entry.gapMechanism !== undefined && !known.has(entry.gapMechanism)) {
        unknown.add(
          `key ${group.path}:${entry.line} declares gapMechanism "${entry.gapMechanism}"`,
        );
      }
      // A mechanism on an entry with no gap has nothing to retire and is a transcription
      // slip, not a policy: it would sit there looking meaningful and doing nothing.
      if (entry.gapMechanism !== undefined && entry.knownGap === undefined) {
        unknown.add(`key ${group.path}:${entry.line} declares a gapMechanism but has no knownGap`);
      }
    }
  }
  for (const mechanism of exercises) {
    if (!known.has(mechanism)) unknown.add(`caller claims to exercise "${mechanism}"`);
  }
  if (unknown.size > 0) {
    const vocabulary = GAP_MECHANISMS.join(', ');
    const offenders = [...unknown].sort().join('\n  ');
    throw new Error(`unknown gap mechanism(s) — the vocabulary is ${vocabulary}:\n  ${offenders}`);
  }
}

/**
 * Does the matrix's own arithmetic close?
 *
 * 🔴 **A TABLE THAT DOES NOT ADD UP STILL PRINTS, and it prints confidently.** Every
 * entry lands in exactly one bucket, so per row `met + missed + threw + knownGap +
 * staleGap` must equal `expected`, and the row totals must equal the number of entries
 * the key holds. Nothing else in this file would notice if a verdict started
 * double-counting or went to a bucket name that does not exist — `row[verdict.bucket] +=
 * 1` would happily create one.
 *
 * ⚠️ **This exists because I tried to check it from OUTSIDE, by parsing the rendered
 * table, and my regex silently matched only the 62 rows that had no direction label —
 * then reported a one-entry discrepancy that was entirely my parser's.** An instrument
 * that can only be verified by scraping its own output is an instrument nobody will
 * verify twice.
 */
export function reconcile(rows, key, findings) {
  const problems = [];
  let expected = 0;
  for (const row of rows) {
    // Summed over `BUCKETS`, which is also what the table prints. Before R96 this summed a
    // hand-written list of six while the table printed a hand-written list of five, and
    // the discrepancy was invisible from here: this loop closed, the table did not, and
    // only the ✅ was on the page.
    const parts = BUCKETS.reduce((total, bucket) => total + row[bucket.key], 0);
    if (parts !== row.expected) {
      problems.push(`${row.shape}: buckets sum to ${parts}, expected ${row.expected}`);
    }
    expected += row.expected;
  }
  const entries = key.files.reduce((total, group) => total + group.entries.length, 0);
  if (expected !== entries) {
    problems.push(`rows account for ${expected} entries, the key holds ${entries}`);
  }
  // Every finding belongs to exactly one bucket that declares `emitsFinding`, so the two
  // counts must agree — and which buckets those are is read from `BUCKETS` rather than
  // listed again here.
  const accounted = rows.reduce(
    (total, row) =>
      total + BUCKETS.reduce((sum, bucket) => sum + (bucket.emitsFinding ? row[bucket.key] : 0), 0),
    0,
  );
  if (accounted !== findings.length) {
    problems.push(`${accounted} finding-bearing entries against ${findings.length} findings`);
  }
  return { closes: problems.length === 0, problems, entries };
}

/**
 * One divergence, carrying BOTH sides' reasoning.
 *
 * 🔴 **A DIVERGENCE IS A QUESTION UNTIL SOMEBODY HAS OPENED BOTH SIDES (R90), so the
 * output opens them.** The key's `why` is the tree author's claim about what a correct
 * engine does; the engine's `note` is what it says about its own decision. Printing
 * `expected resolved, engine said absent` and stopping makes every one of these a
 * separate investigation with a separate probe — and there are dozens.
 *
 * ⚠️ **The reason this is worth the width: a row reading `0 of 4` MAY MEAN THE KEY IS
 * WRONG.** Six key occurrence defects were corrected in one session, and then the seventh
 * `0 of 4` row was read as an engine P0 and labelled "not a judgement call" — it was a
 * key defect too (R90). As the tree gets measured, the tree gets corrected. Whichever side
 * is wrong, the two claims side by side are what settle it.
 */
function finding(group, entry, kind, detail, engineNote) {
  return {
    file: group.path,
    line: entry.line,
    raw: entry.raw,
    shape: entry.shape,
    kind,
    detail,
    // Both sides' own words, so a reader can adjudicate without opening two files.
    keyWhy: entry.why ?? '',
    keyGap: entry.knownGap ?? '',
    // R96: which mechanism this entry's gap names, when it names one. Carried on the
    // finding so the renderer can say WHICH instrument would have to run, rather than
    // only that some instrument did not.
    gapMechanism: entry.gapMechanism ?? '',
    engineNote: engineNote ?? '',
  };
}

/**
 * Kinds that are NOT defects: reported for visibility, never counted against the run.
 *
 * ⚠️ `gap-not-exercised` is here **and it is not a concession.** It says "this instrument
 * cannot answer this question", which is a fact about the harness, not a fault in the
 * engine — and gating on it would make the run permanently red for a configuration
 * `measure.mjs` chose on purpose. A permanently-red gate is a gate people route around,
 * and that is how the pre-commit hook nearly died. It is printed under its own heading
 * instead, with a count, so it cannot be mistaken for a clean row.
 */
export const NON_DEFECT_KINDS = ['threw-expected-silence', 'gap-not-exercised'];

/**
 * What one keyed entry turned out to be. Split out of `buildMatrix` rather than
 * suppressed when the complexity rule fired on it (R81's precedent: answer the rule,
 * never silence it) — and the four outcomes read as a ladder here, which the inlined
 * version did not.
 */
function classify(entry, observation, exercises = new Set()) {
  // A file we never observed is not evidence of anything. Reported per entry, so the
  // row's `expected` still counts it rather than the group vanishing.
  if (observation === undefined) {
    return {
      bucket: 'missed',
      kind: 'not-observed',
      detail: 'the harness never measured this file',
    };
  }

  const found = observation.references.find((reference) => reference.start === entry.offset);

  // R86. Silence is what a correct refusal produces AND what a crashed adapter produces,
  // so the two are separated here, named, and never folded together.
  //
  // ⚠️ THE ORDER MATTERS AND I HAD IT WRONG. Checking `threw` first credited a partially
  // read file with nothing — and R20's fix is precisely that a throw CARRIES the
  // references already collected, so `scanSources` records the skip and keeps them. A
  // file can legitimately be both partly measured and recorded unscanned. Testing for the
  // reference first means the throw explains only the entries actually missing, which is
  // also the only way this harness can show whether R20's preservation works.
  if (found === undefined && observation.threw !== null) {
    // 🔴 R86 AND R90 MEET HERE, and collapsing either way would be wrong. R86: a throw is
    // never merged into a refusal, because silence from a crash and silence from a correct
    // decline are indistinguishable and mean opposite things. R90: where the key's expect
    // ACCEPTS silence, the throw is the mechanism by which the right thing happened — so
    // it is reported, named, and NOT a defect. `entity.html`'s four swallowed entries are
    // exactly this: the file cannot be parsed, and a browser renders nothing there either.
    const silenceIsRight = (ACCEPTS[entry.expect] ?? []).includes('absent');
    return {
      bucket: 'threw',
      kind: silenceIsRight ? 'threw-expected-silence' : 'threw',
      detail: observation.threw,
      note: '',
    };
  }

  const actual = found === undefined ? 'absent' : found.resolution;
  const agrees = (ACCEPTS[entry.expect] ?? []).includes(actual);
  const note = found?.note ?? '';

  if (entry.knownGap !== undefined) {
    // 🔴 R96, AND IT IS CHECKED BEFORE `agrees` RATHER THAN AFTER. A gap naming a mechanism
    // this run does not exercise cannot be retired by this run, and — this is the whole
    // point — it is *agreement* that would retire it. The two
    // `docs-examples/public/example.html` entries expect `broken`, the engine under
    // declared roots says `broken`, they agreed, and the matrix printed "the gap is
    // closed" about a defect that fires on every real invocation. Reading the agreement
    // first and the mechanism second is the version of this that shipped.
    if (entry.gapMechanism !== undefined && !exercises.has(entry.gapMechanism)) {
      return {
        bucket: 'notExercised',
        kind: 'gap-not-exercised',
        detail:
          `this run does not exercise \`${entry.gapMechanism}\`, so the gap can be neither ` +
          `confirmed nor retired here — the engine said ${actual}, which is not evidence`,
        note,
      };
    }
    // A knownGap that has been closed must be REMOVED, not left standing. Same hazard as
    // a growth-list shape that quietly gained coverage: a debt nobody settles the record
    // of goes on being printed as a debt, and a reader learns to discount the column.
    return agrees
      ? {
          bucket: 'staleGap',
          kind: 'stale-known-gap',
          detail: `engine now produces ${actual}; the gap is closed`,
          note,
        }
      : { bucket: 'knownGap', kind: null, detail: '', note };
  }

  return agrees
    ? { bucket: 'met', kind: null, detail: '', note }
    : {
        bucket: 'missed',
        kind: 'wrong-outcome',
        detail: `expected ${entry.expect}, engine said ${actual}`,
        note,
      };
}

/**
 * The other direction: a reference the engine emits where the key lists nothing.
 *
 * 🔴 **The probe could not see these at all**, because it joined on key positions. An
 * unkeyed emission is the more dangerous direction of the two: a miss is a gap in
 * coverage, an unkeyed emission is the engine claiming something nobody sanctioned — and
 * `--replace` rewrites what the engine claims.
 *
 * ⚠️ Scoped to the files the key lists and to references that resolved to an asset. The
 * tree holds fonts, video and package imports the key deliberately does not enumerate,
 * and counting those would bury the signal in a list nobody reads — which is R75's
 * complaint about a row a reader learns to ignore, one level up.
 */
export function unkeyedEmissions(key, observed) {
  const out = [];
  for (const group of key.files) {
    const observation = observed.get(group.path);
    if (observation === undefined || observation.threw !== null) continue;
    const keyed = new Set(group.entries.map((entry) => entry.offset));
    for (const reference of observation.references) {
      if (keyed.has(reference.start)) continue;
      if (reference.resolution !== 'resolved' && reference.resolution !== 'resolved-pattern')
        continue;
      out.push({
        file: group.path,
        start: reference.start,
        shape: reference.shape,
        resolution: reference.resolution,
        rawPath: reference.rawPath,
      });
    }
  }
  return out;
}

/**
 * Where the engine's SHAPE differs from the key's, and whether that is a defect.
 *
 * 🔴 **It is a defect only when the shape declares no `adapterEmitsAs` containing the
 * engine's shape (R87).** Some shapes are distinctions only the resolver can draw — a
 * `decoy.typo` cannot be told from a real path without checking the disk — and for those
 * the adapter correctly emits something broader. **The harness reads that declaration; it
 * does not keep a list of its own.** A hand-written roster of exemptions rots the first
 * time a shape moves layer, and rots silently, because an exemption that is no longer
 * needed still suppresses.
 *
 * @param declarationOf `(shapeId) => { adapterEmitsAs?: string[] } | undefined`, supplied
 *   by the caller so this module stays free of the engine it measures.
 */
export function shapeDisagreements(key, observed, declarationOf = () => undefined) {
  const out = [];
  for (const group of key.files) {
    const observation = observed.get(group.path);
    if (observation === undefined || observation.threw !== null) continue;
    for (const entry of group.entries) {
      const found = observation.references.find((reference) => reference.start === entry.offset);
      if (found === undefined || found.shape === entry.shape) continue;
      const declared = declarationOf(entry.shape)?.adapterEmitsAs ?? [];
      out.push({
        file: group.path,
        line: entry.line,
        keyShape: entry.shape,
        engineShape: found.shape,
        explained: declared.includes(found.shape),
      });
    }
  }
  return out;
}

/**
 * What this instrument cannot tell you, as prose, so a rendering cannot omit it.
 *
 * ⚠️ **Returned rather than written into the renderer** because the renderer is the part
 * somebody will rewrite, and a caveat that lives in the thing being rewritten is a caveat
 * with a half-life. Every number this harness prints is bounded by all three.
 */
export function blindSpots() {
  return [
    'It cannot see a CLASSIFICATION defect. It reports where the key and the engine ' +
      'differ; where they agree and are both wrong it reports nothing. R80(a) sat ' +
      'unapplied for a day inside this blind spot — both instruments called a partial ' +
      'pattern a complete one.',
    'It measures only the shapes the tree HAS. A shape nobody imagined does not appear ' +
      "as a failure here, it appears as nothing. That gap is R76b's measurement, not this one.",
    'Every `expect` is a judgement somebody made. The self-check proves the key describes ' +
      'the tree; nothing proves the key describes a CORRECT engine.',
  ];
}

/**
 * Render the matrix.
 *
 * 🔴 **NO TOTAL ROW, AND NOT AS AN OVERSIGHT (R75).** A single number over heterogeneous
 * shapes is exactly what escapes into a README, and the matrix's value is that it names
 * *where to add an adapter next* rather than scoring anything. The per-row counts are the
 * product; there is deliberately nothing to quote.
 *
 * ⚠️ A `declined`-class row reads BACKWARDS — for `discarded` and `out-of-scope` a
 * non-zero `missed` means the engine CLAIMED something it should have refused. The
 * heading says so rather than leaving a reader to infer the direction per row.
 */
export function renderMatrix(result, { emissionOf = () => undefined } = {}) {
  const width = Math.max(28, ...result.rows.map((row) => row.shape.length));
  return [
    ...heading(),
    ...arithmeticLine(result),
    ...populations(result, emissionOf),
    ...notExercisedNote(result),
    ...rowTable(result, emissionOf, width),
    ...findingList(result),
    ...unkeyedList(result),
    ...disagreementList(result),
    ...blindSpotList(),
  ].join('\n');
}

// Each section below was inlined in `renderMatrix` until the complexity rule fired on it
// at 35 — the highest in the repository. Split rather than suppressed (R81's precedent:
// answer the rule), and the sections are now individually readable, which the 90-line
// version was not.

function heading() {
  return [
    'coverage matrix — one row per shape, and DELIBERATELY NO TOTAL (R75)',
    '',
    '🔴 FOUR DIRECTIONS, AND SUMMING ACROSS THEM WOULD BE MEANINGLESS. A `claimed` row counts ' +
      'found against expected. A `refusal` row reads BACKWARDS — the text is not a live path, so ' +
      'a zero is right and a non-zero is the failure. An `unclaimed` row is a SCOPE DECISION: a ' +
      'real file we choose not to index, and a miss there is not a bug (R92). A `gap` row is an ' +
      'acknowledged debt with a ruling behind it.',
  ];
}

function arithmeticLine(result) {
  if (result.arithmetic.closes) {
    return [
      '',
      `✅ arithmetic closes: every one of ${result.arithmetic.entries} key entries is in exactly one bucket.`,
    ];
  }
  return [
    '',
    '🔴 THE ARITHMETIC DOES NOT CLOSE. Every number below is suspect:',
    ...result.arithmetic.problems.map((problem) => `     ${problem}`),
  ];
}

/**
 * 🔴 **THE HONEST DENOMINATOR (R92): the shapes we CLAIM are the only population where a
 * miss is a bug.** Per direction, and never one figure across all four — the whole value
 * of this table is that there is nothing to quote out of context.
 */
function populations(result, emissionOf) {
  const buckets = new Map();
  for (const row of result.rows) {
    const emission = emissionOf(row.shape) ?? 'engine';
    // ⚠️ `gap` is its OWN population and is deliberately not folded into `claimed`. A gap
    // is an acknowledged debt with a ruling behind it, so counting its 47 entries against
    // the claimed figure would drag that number down for a reason that is not a defect —
    // and `claimed` has to mean exactly "a miss here is a bug" or it means nothing at all.
    const direction = emission === 'engine' ? 'claimed' : emission;
    const bucket = buckets.get(direction) ?? { rows: 0, expected: 0, met: 0, missed: 0 };
    bucket.rows += 1;
    bucket.expected += row.expected;
    bucket.met += row.met;
    bucket.missed += row.missed;
    buckets.set(direction, bucket);
  }

  const lines = ['', 'populations — read separately, never added together:'];
  for (const [direction, bucket] of [...buckets].sort()) {
    const count = String(bucket.rows).padStart(3);
    lines.push(`  ${direction.padEnd(11)} ${count} rows  ${reading(direction, bucket)}`);
  }
  return lines;
}

/**
 * 🔴 **R96, stated on the page rather than only in a column.** An entry counted here is
 * one the harness is NOT QUALIFIED to judge: its `knownGap` names a mechanism this run
 * switched off, so both a match and a mismatch would be an artefact of the configuration.
 * The `n/x` column carries the number; this paragraph carries the reason, because a reader
 * scanning for zeroes will read a column as "nothing to see".
 */
function notExercisedNote(result) {
  const items = result.findings.filter((item) => item.kind === 'gap-not-exercised');
  if (items.length === 0) return [];
  const mechanisms = [...new Set(items.map((item) => item.gapMechanism))].sort();
  return [
    '',
    `⚠️  ${items.length} entr${items.length === 1 ? 'y is' : 'ies are'} NOT EXERCISED by this run ` +
      `(mechanism${mechanisms.length === 1 ? '' : 's'}: ${mechanisms.join(', ')}).`,
    '   Their knownGaps can be neither confirmed nor retired here, and the engine agreeing with',
    '   the key on them means nothing — the mechanism the gap names never ran. Before R96 these',
    '   printed as "the gap is closed", which retired a live defect and deleted the only record',
    '   of it. They are listed under findings as `gap-not-exercised`.',
  ];
}

function reading(direction, bucket) {
  if (direction === 'claimed') {
    return `${bucket.met} of ${bucket.expected} met — THE ONLY POPULATION WHERE A MISS IS A BUG`;
  }
  if (direction === 'gap') {
    return `${bucket.expected} entries nothing reads yet, each with a knownGap naming the ruling`;
  }
  return `${bucket.expected} entries, ${bucket.missed} where the engine claimed something`;
}

/** The buckets other than `met`, which is printed against `expected` rather than beside it. */
const NON_MET_BUCKETS = BUCKETS.filter((bucket) => bucket.key !== 'met');

/**
 * The numbers this row actually PRINTS, in print order.
 *
 * 🔴 **The renderer and the check now read the same function.** The bug R96 was found
 * through was two independent enumerations of one bucket set — `reconcile` summed six and
 * the table printed five — so the table under-reported seven entries while the arithmetic
 * line said ✅. Deriving the cells from `BUCKETS` means a new bucket appears as a column
 * whether or not anybody remembers to add one.
 */
function cellsOf(row) {
  return NON_MET_BUCKETS.map((bucket) => row[bucket.key]);
}

function rowTable(result, emissionOf, width) {
  const pad = (text) => String(text).padEnd(width);
  const num = (value) => String(value).padStart(4);
  const headers = NON_MET_BUCKETS.map((bucket) => num(bucket.label)).join(' ');
  const lines = [
    '',
    `${pad('shape')}  ${num('met')}/${num('exp')}  ${headers}  direction`,
    '-'.repeat(width + 40),
  ];
  for (const row of result.rows) {
    const cells = cellsOf(row).map(num).join(' ');
    const counts = `${num(row.met)}/${num(row.expected)}  ${cells}`;
    lines.push(`${pad(row.shape)}  ${counts}  ${directionOf(emissionOf(row.shape))}`);
  }
  // 🔴 THE PRINTED TABLE, CHECKED AS PRINTED. `reconcile` proves the data structure adds
  // up; this proves the PAGE does. They were the same proof until they silently were not,
  // and the gap between them was where seven entries lived for a day.
  const unbalanced = result.rows.filter(
    (row) => row.met + cellsOf(row).reduce((total, cell) => total + cell, 0) !== row.expected,
  );
  if (unbalanced.length > 0) {
    lines.push(
      '',
      '🔴 THE COLUMNS ABOVE DO NOT SUM TO `exp` ON THESE ROWS, SO THE TABLE IS HIDING ENTRIES:',
      ...unbalanced.map((row) => `     ${row.shape}`),
      '   A bucket exists that no column prints. Add it to BUCKETS rather than to this list.',
    );
  }
  return lines;
}

function directionOf(emission) {
  if (emission === 'declined') {
    return 'refusal — not a live path; a MISS here means the engine claimed it';
  }
  if (emission === 'unclaimed') {
    return 'UNCLAIMED — a real file, deliberately not indexed. A miss is not a bug';
  }
  if (emission === 'gap') return 'gap — zero is expected until a reader exists';
  return '';
}

function findingList(result) {
  const defects = result.findings.filter((item) => !NON_DEFECT_KINDS.includes(item.kind));
  const noted = result.findings.filter((item) => NON_DEFECT_KINDS.includes(item.kind));
  const lines = [
    '',
    `findings: ${defects.length} to answer, ${noted.length} noted`,
    "  🔴 EACH ONE IS A QUESTION, NOT A VERDICT (R90). Both sides state their case: the key's " +
      "`why` is what the tree author says a correct engine does; the engine's note is what it " +
      'says about its own decision. A row reading 0 of N may mean the KEY is wrong.',
  ];
  for (const item of [...defects, ...noted]) {
    const where = `${item.file}:${item.line} ${JSON.stringify(item.raw)}`;
    lines.push(`  [${item.kind}] ${where} — ${item.detail}`);
    if (item.keyWhy !== '') lines.push(`        key says:    ${item.keyWhy}`);
    if (item.keyGap !== '') lines.push(`        knownGap:    ${item.keyGap}`);
    if (item.engineNote !== '') lines.push(`        engine says: ${item.engineNote}`);
  }
  return lines;
}

function unkeyedList(result) {
  return [
    '',
    `unkeyed emissions (engine claimed, key lists nothing): ${result.unkeyed.length}`,
    ...result.unkeyed.map(
      (item) =>
        `  ${item.file}@${item.start} ${item.shape} ${item.resolution} ${JSON.stringify(item.rawPath)}`,
    ),
  ];
}

function disagreementList(result) {
  const unexplained = result.shapeDisagreements.filter((item) => !item.explained);
  return [
    '',
    `shape disagreements: ${result.shapeDisagreements.length}, of which UNEXPLAINED: ${unexplained.length}`,
    '  (explained = the key shape declares adapterEmitsAs naming what the engine emitted — R87)',
    ...unexplained.map(
      (item) => `  ${item.file}:${item.line}  key ${item.keyShape}  ->  engine ${item.engineShape}`,
    ),
  ];
}

function blindSpotList() {
  return [
    '',
    '🔴 what this instrument cannot tell you:',
    ...blindSpots().map((spot) => `  - ${spot}`),
  ];
}
