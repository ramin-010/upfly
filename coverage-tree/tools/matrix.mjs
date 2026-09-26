/**
 * The coverage matrix: what the engine did against what the answer key says a correct
 * engine does, one row per reference shape.
 *
 * It imports nothing, not the engine and not `node:fs`, and takes the key and the engine's
 * observations as arguments, so `coverage-matrix.test.ts` can feed it damaged inputs and
 * check that each row goes the wrong way. It judges outcomes, not shapes: a shape that
 * differs from the key's is listed apart and is never a miss. A file the scanner could not
 * read is its own outcome, never a refusal. The join runs both ways, and there is no total.
 * See "Measuring the engine against the tree" in ARCHITECTURE.md.
 */

/**
 * Which engine outcomes satisfy one `expect` value. `absent` means the engine produced no
 * reference at that position.
 *
 * `discarded` and `out-of-scope` also accept silence, as the key's `expectSemantics` says: a
 * `url()` in a comment is never collected, while a path-shaped guess that misses is collected
 * and discarded; an absolute URL is dropped by `isExternalUrl` before it is a reference, while
 * a real `.mp4` becomes one the engine declines to index.
 */
export const ACCEPTS = {
  resolved: ['resolved'],
  'resolved-pattern': ['resolved-pattern'],
  dynamic: ['dynamic'],
  broken: ['broken'],
  'unresolved-alias': ['unresolved-alias'],
  discarded: ['discarded', 'absent'],
  'out-of-scope': ['out-of-scope', 'absent'],
};

/**
 * Outcomes that must never satisfy `discarded` or `out-of-scope`, the two expects that also
 * accept silence. `coverage-matrix.test.ts` checks that the matrix refuses each of them.
 */
export const NEVER_ACCEPTABLE_AS_SILENCE = ['resolved', 'resolved-pattern', 'broken'];

/** Byte offset to UTF-16 code-unit offset: the key counts bytes, the engine code units. */
export function toCodeUnits(bytes, byteOffset) {
  return bytes.subarray(0, byteOffset).toString('utf8').length;
}

/**
 * Every bucket an entry can land in, declared once. `reconcile` sums these and the table
 * prints a column for each, so a bucket cannot hold entries that no column shows.
 * `emitsFinding` says whether an entry in the bucket produces a finding, which `reconcile`
 * checks against the findings list.
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
 * The mechanisms a `knownGap` can name, and so the values a key entry's `gapMechanism` may
 * take. A gap about a mechanism can only be retired by a run that used it: a run with
 * declared serving roots never runs detection, so its agreeing with the key says nothing
 * about a detection gap. Declared per entry rather than read from the gap's prose, because
 * matching English would fail in the direction that deletes a live gap.
 * See "Measuring the engine against the tree" in ARCHITECTURE.md.
 */
export const GAP_MECHANISMS = Object.freeze([
  // Finding serving roots by directory name (`detectServingRoots`). It never runs when the
  // caller declares its roots, as `measure.mjs` does for its first run.
  'serving-root-detection',
]);

/**
 * Compares the answer key with what the engine produced, entry by entry.
 *
 * @param key the parsed answer key.
 * @param observed one entry per keyed file:
 *   `{ path, threw: string | null, references: [{ start, shape, resolution }] }`
 *   where `start` is a UTF-16 code-unit offset and `threw` is the reason the scanner
 *   could not read the file at all. A keyed file missing from this map is reported as
 *   `not-observed`, never skipped, so a run that measured nothing cannot read as clean.
 * @param exercises the `GAP_MECHANISMS` this run uses. A `knownGap` naming a mechanism
 *   outside this set and outside `outOfConfiguration` can be neither confirmed nor retired
 *   by the run, and lands in `notExercised`. The default is empty, so a gap stays open
 *   until a caller states that it ran the mechanism the gap is about.
 * @param observedUnder `{ [mechanism]: Map }`: a separate run, made with that mechanism in
 *   use, on which an entry whose gap names it is judged. Without one, such an entry is
 *   judged on `observed`, which is only sound if `observed` used the mechanism too.
 * @param outOfConfiguration mechanisms this run's configuration does not use at all, as
 *   detection is unused when the key states its serving roots. An entry whose gap names one
 *   is judged on its outcome, `met` or `missed`, and its gap is never retired: the run that
 *   uses the mechanism judges the gap. These entries are listed in
 *   `result.outOfConfiguration` so the page can say so.
 */
export function buildMatrix(
  key,
  observed,
  {
    declarationOf = () => undefined,
    exercises = new Set(),
    observedUnder = {},
    outOfConfiguration = new Set(),
  } = {},
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

  assertRunsAreConsistent(exercises, observedUnder, outOfConfiguration);
  assertMechanismsAreDeclared(key, exercises, outOfConfiguration);

  const judgedOnOutcome = [];
  const verdicts = [];
  for (const group of key.files) {
    for (const entry of group.entries) {
      const row = rowOf(entry.shape);
      row.expected += 1;
      const run = runFor(entry, exercises, observedUnder) ?? observed;
      const verdict = classify(entry, run.get(group.path), exercises, outOfConfiguration);
      row[verdict.bucket] += 1;
      // Every entry's bucket, so a run can name each entry it did not meet. The findings
      // list cannot: a `knownGap` entry is unmet and produces no finding.
      verdicts.push({
        file: group.path,
        line: entry.line,
        raw: entry.raw,
        shape: entry.shape,
        bucket: verdict.bucket,
        detail: verdict.detail,
        keyGap: entry.knownGap ?? '',
      });
      if (verdict.kind !== null) {
        findings.push(finding(group, entry, verdict.kind, verdict.detail, verdict.note));
      }
      if (entry.gapMechanism !== undefined && outOfConfiguration.has(entry.gapMechanism)) {
        judgedOnOutcome.push({
          file: group.path,
          line: entry.line,
          raw: entry.raw,
          gapMechanism: entry.gapMechanism,
          bucket: verdict.bucket,
        });
      }
    }
  }

  return {
    rows: [...rows.values()].sort((a, b) => a.shape.localeCompare(b.shape)),
    findings,
    unkeyed: unkeyedEmissions(key, observed),
    shapeDisagreements: shapeDisagreements(key, observed, declarationOf),
    arithmetic: reconcile([...rows.values()], key, findings),
    outOfConfiguration: judgedOnOutcome,
    verdicts,
  };
}

/** The separate run an entry is judged on, when its gap names a mechanism this run exercises. */
function runFor(entry, exercises, observedUnder) {
  if (entry.gapMechanism === undefined || !exercises.has(entry.gapMechanism)) return undefined;
  return observedUnder[entry.gapMechanism];
}

/** What a caller says about its runs must hang together before any entry is read. */
function assertRunsAreConsistent(exercises, observedUnder, outOfConfiguration) {
  // A run supplied for a mechanism the caller does not exercise would look like evidence
  // and judge nothing.
  for (const mechanism of Object.keys(observedUnder)) {
    if (!exercises.has(mechanism)) {
      throw new Error(
        `a run is supplied for "${mechanism}", which the caller does not claim to exercise`,
      );
    }
  }
  // A configuration either uses a mechanism or it does not, so a mechanism named as both is
  // a mistake in the caller.
  for (const mechanism of outOfConfiguration) {
    if (exercises.has(mechanism)) {
      throw new Error(
        `"${mechanism}" is claimed as exercised AND as outside this configuration — it cannot be both`,
      );
    }
  }
}

/**
 * Every `gapMechanism` the key names, and every mechanism the caller names, must be in
 * `GAP_MECHANISMS`. It throws rather than reporting, because a misspelling would show no
 * red row, only a quietly wrong table: a misspelled `gapMechanism` would leave its entry
 * not exercised forever, and a misspelled `exercises` entry would make the run claim less
 * than it did.
 */
function assertMechanismsAreDeclared(key, exercises, outOfConfiguration = new Set()) {
  const known = new Set(GAP_MECHANISMS);
  const unknown = new Set();
  for (const group of key.files) {
    for (const entry of group.entries) {
      if (entry.gapMechanism !== undefined && !known.has(entry.gapMechanism)) {
        unknown.add(
          `key ${group.path}:${entry.line} declares gapMechanism "${entry.gapMechanism}"`,
        );
      }
      // A mechanism on an entry with no gap has nothing to retire, so it is a slip in the key.
      if (entry.gapMechanism !== undefined && entry.knownGap === undefined) {
        unknown.add(`key ${group.path}:${entry.line} declares a gapMechanism but has no knownGap`);
      }
    }
  }
  for (const mechanism of exercises) {
    if (!known.has(mechanism)) unknown.add(`caller claims to exercise "${mechanism}"`);
  }
  for (const mechanism of outOfConfiguration) {
    if (!known.has(mechanism)) unknown.add(`caller puts "${mechanism}" outside its configuration`);
  }
  if (unknown.size > 0) {
    const vocabulary = GAP_MECHANISMS.join(', ');
    const offenders = [...unknown].sort().join('\n  ');
    throw new Error(`unknown gap mechanism(s) — the vocabulary is ${vocabulary}:\n  ${offenders}`);
  }
}

/**
 * Whether the matrix's own arithmetic closes. A table that does not add up still prints.
 *
 * Every entry lands in exactly one bucket, so per row the buckets must sum to `expected`,
 * and the rows must account for every entry the key holds. Nothing else would notice a
 * verdict counted twice or sent to a bucket that does not exist: `row[verdict.bucket] += 1`
 * would create one.
 */
export function reconcile(rows, key, findings) {
  const problems = [];
  let expected = 0;
  for (const row of rows) {
    // Summed over `BUCKETS`, the list the table's columns come from.
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
  // Every finding comes from an entry in a bucket that declares `emitsFinding`, so the two
  // counts must agree.
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
 * One divergence, carrying both sides' reasoning: the key's `why`, the tree author's claim
 * about what a correct engine does, and the engine's `note` about its own decision. A
 * divergence can mean the key is wrong as easily as the engine, and the two claims side by
 * side are what settle which.
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
    // The mechanism the entry's gap names, if any, so the page can say which mechanism a
    // run would have to use to judge the gap.
    gapMechanism: entry.gapMechanism ?? '',
    engineNote: engineNote ?? '',
  };
}

/**
 * Finding kinds reported for visibility and never counted against the run.
 * `gap-not-exercised` says this run cannot judge the gap, a fact about the harness rather
 * than a fault in the engine. Counting it would keep the run red for a configuration
 * `measure.mjs` chooses on purpose, and a check that is always red gets routed around.
 */
export const NON_DEFECT_KINDS = ['threw-expected-silence', 'gap-not-exercised'];

/** What one keyed entry turned out to be. */
function classify(entry, observation, exercises = new Set(), outOfConfiguration = new Set()) {
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

  // A crashed adapter is as silent as a correct refusal, so a throw is its own outcome and
  // never counts as a refusal. The reference is looked up first: `scanSources` keeps the
  // references an adapter found before it threw, so a file can be partly measured and still
  // recorded as unscanned, and the throw explains only the entries actually missing.
  if (found === undefined && observation.threw !== null) {
    // Where the expect accepts silence, the throw brought about the right outcome, as when
    // an unclosed `<style>` swallows text a browser does not render either. It is still
    // named as a throw, under its own kind, and is not a defect.
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
    return gapVerdict(entry, { actual, agrees, note }, exercises, outOfConfiguration);
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
 * The verdict on an entry that carries a `knownGap`. Where the run's configuration does not
 * use the gap's mechanism, the entry is judged on its outcome; where the run does not say it
 * exercised the mechanism, the entry is not exercised; otherwise the gap is confirmed or
 * found stale.
 */
function gapVerdict(entry, { actual, agrees, note }, exercises, outOfConfiguration) {
  // The gap is about a setup this run does not have, such as detection under declared
  // serving roots, so the entry is judged on what this setup produced. `met` here says
  // nothing about the gap, which stays open for the run that uses the mechanism.
  if (entry.gapMechanism !== undefined && outOfConfiguration.has(entry.gapMechanism)) {
    return agrees
      ? { bucket: 'met', kind: null, detail: '', note }
      : {
          bucket: 'missed',
          kind: 'wrong-outcome',
          detail: `expected ${entry.expect}, engine said ${actual} — under a configuration that does not use \`${entry.gapMechanism}\`, so the gap does not explain it`,
          note,
        };
  }
  // Checked before `agrees`, because agreement is what would retire the gap, and a run
  // that did not use the mechanism cannot retire it: under declared roots, an entry whose
  // gap is about detection can agree with its `expect` for reasons unrelated to the gap.
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
  // A gap the engine now closes is reported as stale so its record gets removed, rather
  // than printed as an open gap that readers learn to discount.
  return agrees
    ? {
        bucket: 'staleGap',
        kind: 'stale-known-gap',
        detail: `engine now produces ${actual}; the gap is closed`,
        note,
      }
    : { bucket: 'knownGap', kind: null, detail: '', note };
}

/**
 * The other direction: references the engine resolved where the key lists nothing. This is
 * the more dangerous of the two, since a miss is a gap in coverage while an unkeyed emission
 * is the engine claiming a link nobody sanctioned, and a rewrite acts on what it claims.
 *
 * Only the files the key lists, and only references that resolved to an asset: the tree
 * holds fonts, video and package imports the key does not enumerate, and listing those
 * would bury the signal.
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
 * Where the engine's shape differs from the key's, and whether the difference is explained:
 * it is when the key's shape lists the engine's in `adapterEmitsAs`, because only the
 * resolver can draw that distinction. See "Which layer decides" in ARCHITECTURE.md.
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
 * What this instrument cannot tell you, as text any rendering can print. Returned rather
 * than written into the renderer, which is the part most likely to be rewritten. Every
 * number the harness prints is bounded by all three.
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
 * Renders the matrix. There is no total row: one figure over unlike shapes is what gets
 * quoted out of context, and the rows are there to show where an adapter is missing. A
 * `declined` row reads backwards, since a miss there means the engine claimed text it should
 * have refused, and the heading says so. See "What a zero means" in ARCHITECTURE.md.
 */
export function renderMatrix(result, { emissionOf = () => undefined } = {}) {
  const width = Math.max(28, ...result.rows.map((row) => row.shape.length));
  return [
    ...heading(),
    ...arithmeticLine(result),
    ...populations(result, emissionOf),
    ...notExercisedNote(result),
    ...outOfConfigurationNote(result),
    ...rowTable(result, emissionOf, width),
    ...findingList(result),
    ...unkeyedList(result),
    ...disagreementList(result),
    ...blindSpotList(),
  ].join('\n');
}

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
 * One line per population, never one figure across them. The claimed population is the only
 * one where a miss is a bug.
 */
function populations(result, emissionOf) {
  const buckets = tally(result, emissionOf);
  const lines = ['', 'populations — read separately, never added together:'];
  for (const [direction, bucket] of [...buckets].sort()) {
    const count = String(bucket.rows).padStart(3);
    lines.push(`  ${direction.padEnd(11)} ${count} rows  ${reading(direction, bucket)}`);
  }
  return lines;
}

/**
 * The `claimed` population's `met` of `expected`, the figure each run publishes, and every
 * claimed entry it did not meet. Exported so `measure.mjs` takes each run's figure from the
 * tally the table prints, rather than deciding again which rows are claimed.
 */
export function claimedPopulation(result, { emissionOf = () => undefined } = {}) {
  const bucket = tally(result, emissionOf).get('claimed');
  const misses = result.verdicts.filter(
    (verdict) => populationOf(verdict.shape, emissionOf) === 'claimed' && verdict.bucket !== 'met',
  );
  return { met: bucket?.met ?? 0, expected: bucket?.expected ?? 0, misses };
}

/** Which population a shape's row belongs to: one rule, for the table and the headline. */
function populationOf(shape, emissionOf) {
  const emission = emissionOf(shape) ?? 'engine';
  return emission === 'engine' ? 'claimed' : emission;
}

/**
 * Everything but the per-shape table: the arithmetic, the populations, the notes, and every
 * finding with both sides' reasoning. For a second run over the same key, where the question
 * is which entries it misses and why, and a second full table would bury the answer under
 * rows that match the first.
 */
export function renderSummary(result, { emissionOf = () => undefined } = {}) {
  return [
    ...arithmeticLine(result),
    ...populations(result, emissionOf),
    ...notExercisedNote(result),
    ...outOfConfigurationNote(result),
    ...findingList(result),
    ...unkeyedList(result),
  ].join('\n');
}

function tally(result, emissionOf) {
  const buckets = new Map();
  for (const row of result.rows) {
    // `gap` is its own population, not part of `claimed`: a gap is a known missing reader,
    // and `claimed` must hold only the rows where a miss is a bug.
    const direction = populationOf(row.shape, emissionOf);
    const bucket = buckets.get(direction) ?? { rows: 0, expected: 0, met: 0, missed: 0 };
    bucket.rows += 1;
    bucket.expected += row.expected;
    bucket.met += row.met;
    bucket.missed += row.missed;
    buckets.set(direction, bucket);
  }
  return buckets;
}

/**
 * The entries this run cannot judge, with the reason: each one's `knownGap` names a
 * mechanism the run did not use, so a match and a mismatch alike come from the
 * configuration. The `n/x` column carries the count and this paragraph the reason, because
 * a reader scanning for zeroes reads a column alone as nothing to see.
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

/**
 * Which entries carrying a gap were judged on their outcome, because this configuration
 * does not use the mechanism the gap names. Without it, a reader could take their `met` for
 * the gap being closed.
 */
function outOfConfigurationNote(result) {
  const items = result.outOfConfiguration ?? [];
  if (items.length === 0) return [];
  const mechanisms = [...new Set(items.map((item) => item.gapMechanism))].sort();
  const met = items.filter((item) => item.bucket === 'met').length;
  return [
    '',
    `ℹ️  ${items.length} entr${items.length === 1 ? 'y carries' : 'ies carry'} a knownGap in a mechanism ` +
      `this configuration does not use (${mechanisms.join(', ')}), so ${items.length === 1 ? 'it is' : 'they are'} ` +
      `judged on what this configuration produced: ${met} met.`,
    '   Their gaps are neither confirmed nor retired here — the run that uses the mechanism',
    '   judges them:',
    ...items.map(
      (item) => `     ${item.file}:${item.line} ${JSON.stringify(item.raw)}  ${item.bucket}`,
    ),
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
 * The numbers this row prints, in print order. The table and its balance check in
 * `rowTable` both read this, and it comes from `BUCKETS`, so a new bucket appears as a
 * column without anyone adding one.
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
  // The table checked as printed: `reconcile` proves the data adds up, and this proves the
  // printed columns do.
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
