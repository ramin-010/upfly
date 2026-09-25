/**
 * Run the engine over the coverage tree and render the matrix. R75's other half.
 *
 * 🔴 **IT RUNS `check-key.mjs --strict` FIRST AND REFUSES TO MEASURE IF THAT FAILS.** A
 * matrix built on a key that does not match the tree is measuring nothing, and it reads
 * exactly like a matrix that is measuring something. A key/tree disagreement is a broken
 * instrument, not a finding — so this exits before producing a single number.
 *
 * ⚠️ **The arithmetic and the rendering are not here.** They are in `matrix.mjs`, which
 * imports nothing at all, so `matrix.test.ts` can hand it damaged instruments and watch
 * every row go the wrong way. This file is the part that touches the world: a subprocess,
 * a filesystem, and the built engine. Keeping it thin is what makes the other file
 * provable.
 *
 * 🔴 **R86 — A THROW IS A THIRD OUTCOME, and the real pipeline is what makes that
 * honest.** `scanSources` catches every adapter throw and records an `UnscannedFile`
 * rather than returning `[]`, so a file that would not parse is *distinguishable* from a
 * file the adapters correctly found nothing in. B7's probe called `findReferences`
 * directly under `catch { emitted = [] }` and lost that distinction for ~150 of 436
 * entries. Reading the pipeline's own bookkeeping is not a workaround for that bug; it is
 * the reason the pipeline has the bookkeeping.
 *
 * 🔴 **R179 — TWO RUNS, TWO NUMBERS, NEVER ADDED TOGETHER.** The same scan is resolved
 * twice and every claimed entry is judged on each: under the key's stated serving roots
 * (run 1), and under no configuration at all — `decideServingRoots`, detection ∪
 * inference, the path a stranger's first run takes (run 2). Until R179 one matrix judged
 * 328 entries on the first setup and 2 on a detection-only run, a blend R174 ruled
 * unquotable. Each number now measures ONE configuration.
 *
 * Usage:  node tools/measure.mjs [--root DIR] [--key PATH] [--skip-strict]
 *         --skip-strict is for debugging the harness itself and prints a loud warning.
 *         It must never be used to produce a number anybody quotes.
 *         Needs `pnpm build`, which `pnpm coverage-tree:measure` runs first.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NON_DEFECT_KINDS,
  blindSpots,
  buildMatrix,
  claimedPopulation,
  renderMatrix,
  renderSummary,
  toCodeUnits,
} from './matrix.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TREE_ROOT = join(HERE, '..');

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const root = resolve(arg('--root', join(TREE_ROOT, 'tree')));
const keyPath = resolve(arg('--key', join(TREE_ROOT, 'key', 'coverage-key.json')));

// ---- the gate ------------------------------------------------------------------
if (process.argv.includes('--skip-strict')) {
  process.stdout.write(
    '⚠️  --skip-strict: the key was NOT verified against the tree. Every number below is\n' +
      '    unsupported and must not be quoted or committed.\n\n',
  );
} else {
  const check = spawnSync(
    process.execPath,
    [join(HERE, 'check-key.mjs'), '--strict', '--root', root, '--key', keyPath],
    { encoding: 'utf8' },
  );
  process.stdout.write(check.stdout ?? '');
  process.stderr.write(check.stderr ?? '');
  if (check.status !== 0) {
    process.stderr.write(
      '\n🔴 REFUSING TO MEASURE. The key and the tree disagree, so a matrix built now would\n' +
        '   be measuring the disagreement rather than the engine. Fix the key first (R75).\n',
    );
    process.exit(1);
  }
  process.stdout.write('\n');
}

// ---- the engine ----------------------------------------------------------------
const DIST = join(HERE, '..', '..', 'packages', 'core', 'dist', 'index.js');
if (!existsSync(DIST)) {
  process.stderr.write(`🔴 ${DIST} is missing. Run \`pnpm build\` first.\n`);
  process.exit(1);
}
const core = await import(`file:///${DIST.replace(/\\/g, '/')}`);
const { defaultAdapters, discover, loadAliases, resolveReferences, scanSources, shapeById } = core;

// Run 2 calls the production decision, never a copy of it. A build older than the
// decision's source is a copy all the same, so it is refused.
const DECISION = join(HERE, '..', '..', 'packages', 'core', 'dist', 'serving-root-decision.js');
const DECISION_SOURCE = join(
  HERE,
  '..',
  '..',
  'packages',
  'core',
  'src',
  'serving-root-decision.ts',
);
if (!existsSync(DECISION) || statSync(DECISION).mtimeMs < statSync(DECISION_SOURCE).mtimeMs) {
  process.stderr.write(
    `${DECISION} is missing or older than its source. Run \`pnpm build\` first.\n`,
  );
  process.exit(1);
}
const { decideServingRoots } = core;

const readFileText = (path) => readFile(path, 'utf8');
const key = JSON.parse(readFileSync(keyPath, 'utf8'));

const discovery = await discover({ root, adapters: defaultAdapters });
const scanned = await scanSources({
  sourceFiles: discovery.sourceFiles,
  adapters: defaultAdapters,
  readFile: readFileText,
  assetBasenames: new Set(
    discovery.assets.map((asset) => asset.relative.split('/').pop()?.toLowerCase() ?? ''),
  ),
});
const aliases = await loadAliases({
  root: discovery.root,
  files: [...discovery.sourceFiles, ...discovery.unscannedFiles],
  readFile: readFileText,
  exists: (path) => existsSync(path),
});
const resolveUnder = (servingRoots) =>
  resolveReferences(scanned.references, {
    root: discovery.root,
    assets: discovery.assets,
    servingRoots,
    excludedRoots: discovery.excludedRoots,
    aliases,
    exists: (path) => existsSync(path),
  });

// RUN 1 — THE KEY'S OWN `servingRoots`, DECLARED. 🔴 And this was a real bug in the first
// run of this harness: auto-detection matches directories NAMED `public` or `static`, and
// the key declares four roots of which `sites/root-served` is R63's shape — a site whose OWN
// directory is the serving root. No name-based detector can find it, so four references
// came out `broken` and the matrix reported them as engine defects. **The engine was
// misconfigured by the instrument measuring it** — R49's cost, arriving inside the thing
// built to measure correctness, and the reason the key states its configuration at all.
// ⚠️ `declared: true` deliberately: the key IS the project stating this. And
// `notServingRoots` is honoured by omission: `docs-examples/public` is named `public` and
// serves nothing, so detection would claim it and the key says it must not be claimed.
const declaredRoots = {
  dirs: key.servingRoots.map((entry) => entry.path),
  declared: true,
};
const referencesDeclared = resolveUnder(declaredRoots);

// RUN 2 — NO CONFIGURATION: exactly what `engine-run.ts` hands the resolver when nobody has
// declared anything, which is what a stranger's first run gets. Detection ∪ inference, NOT
// detection alone: inference is what reaches R63's shape, and a run that left it out would
// report a miss the product does not have.
const decision = decideServingRoots({
  root: discovery.root,
  directories: discovery.directories,
  assets: discovery.assets,
  sourceFiles: discovery.sourceFiles,
  unscannedFiles: discovery.unscannedFiles,
  references: scanned.references,
});
const referencesUnconfigured = resolveUnder(decision.servingRoots);

// ---- one observation per keyed file, per run -----------------------------------
//
// 🔴 The THREW set comes from the pipeline, not from a try/catch of our own. `unscanned`
// carries `parse-failed` (an adapter threw) and `unreadable` (the file could not be
// read); both produce silence, and silence is also what a correct refusal produces.
// ⚠️ `unclaimed-extension` IS NOT A THROW, and conflating them made this harness's first
// run report 37 `unread.*` entries as crashes. Nothing claims a `.vue` or an `.erb`: that
// is a GAP — the row is zero and the key's `knownGap` says which ruling explains it —
// whereas `parse-failed` means an adapter took the file and could not read it. They
// produce identical silence and mean opposite things, which is R86's point restated one
// reason-code along. Only the latter two are misses.
const threwBy = new Map();
for (const file of [...discovery.unscannedFiles, ...scanned.unscanned]) {
  if (file.reason === 'unclaimed-extension') continue;
  threwBy.set(posix(file.relative), `${file.reason}: ${file.detail || '(no detail)'}`);
}

function groupByFile(resolved) {
  const byFile = new Map();
  for (const reference of resolved) {
    const relative = posix(relativeTo(root, reference.file));
    let list = byFile.get(relative);
    if (list === undefined) {
      list = [];
      byFile.set(relative, list);
    }
    list.push({
      start: reference.start,
      shape: reference.shape,
      resolution: reference.resolution,
      rawPath: reference.rawPath,
      // The engine's own words about its decision. R90: a divergence is a question until
      // both sides have stated their case, and this is the engine's half.
      note: reference.note ?? '',
    });
  }
  return byFile;
}
const byFileDeclared = groupByFile(referencesDeclared);
const byFileUnconfigured = groupByFile(referencesUnconfigured);

const observedDeclared = new Map();
const observedUnconfigured = new Map();
for (const group of key.files) {
  // R84. The key counts BYTES and the engine counts UTF-16 CODE UNITS. They agree on
  // ASCII and diverge silently otherwise — one em dash shifts every later offset by 2 —
  // so the key's offsets are converted here, before any join, and never the reverse.
  const bytes = readFileSync(join(root, group.path));
  for (const entry of group.entries) entry.offset = toCodeUnits(bytes, entry.offset);

  const threw = threwBy.get(group.path) ?? null;
  observedDeclared.set(group.path, {
    path: group.path,
    threw,
    references: byFileDeclared.get(group.path) ?? [],
  });
  observedUnconfigured.set(group.path, {
    path: group.path,
    threw,
    references: byFileUnconfigured.get(group.path) ?? [],
  });
}

/**
 * 🔴 R96 — WHICH MECHANISMS EACH RUN USES, STATED PER RUN.
 *
 * Run 1 states its roots, so `serving-root-detection` is not part of its setup at all. A
 * gap naming detection is judged there on its OUTCOME (R179's `outOfConfiguration`) and is
 * never retired by it: before R96, two `docs-examples/public/example.html` entries came
 * out `broken` on this run, matched their `expect`, and the matrix printed "the gap is
 * closed" about a defect that fires on every unconfigured run.
 * Run 2 IS detection (∪ inference), so it exercises the mechanism on its own observations:
 * it is the run that confirms such a gap, or retires it.
 */
const DETECTION = 'serving-root-detection';
const emissionOf = (id) => shapeById(id)?.emission;

const run1 = buildMatrix(key, observedDeclared, {
  declarationOf: (id) => shapeById(id),
  outOfConfiguration: new Set([DETECTION]),
});
const run2 = buildMatrix(key, observedUnconfigured, {
  declarationOf: (id) => shapeById(id),
  exercises: new Set([DETECTION]),
});

const RULE = '='.repeat(90);
process.stdout.write(
  `RUN 1 — THE SUITE'S STATED CONFIGURATION: the key's servingRoots, declared\n   roots: ${declaredRoots.dirs.join(', ')}\n\n`,
);
process.stdout.write(`${renderMatrix(run1, { emissionOf })}\n`);

process.stdout.write(
  [
    '',
    '',
    RULE,
    'RUN 2 — NO CONFIGURATION: decideServingRoots (detection ∪ inference), the path a stranger runs',
    `   roots: ${decision.servingRoots.dirs.join(', ') || '(none)'}`,
    `   detected by name: ${decision.detected.join(', ') || '(none)'}`,
    `   added by inference: ${decision.added.join(', ') || '(none)'}`,
    "   The per-shape table is run 1's; what differs is below, every miss with its entry.",
    '',
  ].join('\n'),
);
process.stdout.write(`${renderSummary(run2, { emissionOf })}\n`);

const one = claimedPopulation(run1, { emissionOf });
const two = claimedPopulation(run2, { emissionOf });
process.stdout.write(
  [
    '',
    RULE,
    'TWO NUMBERS, EACH OVER EVERY CLAIMED ENTRY, NEVER ADDED TOGETHER (R179):',
    `  run 1 — the suite's stated configuration:  claimed ${one.met} of ${one.expected}`,
    ...missLines(one.misses),
    `  run 2 — no configuration:                  claimed ${two.met} of ${two.expected}`,
    ...missLines(two.misses),
    '',
  ].join('\n'),
);

/**
 * Every claimed entry a run did not meet, by name, with why. 🔴 Not the findings list: an
 * entry in `knownGap` is unmet and deliberately produces no finding, so a result that
 * pointed at the findings would drop exactly the misses that have a ruling behind them.
 */
function missLines(misses) {
  return misses.map((miss) => {
    const why = miss.bucket === 'knownGap' ? `knownGap: ${miss.keyGap}` : miss.detail;
    return `      miss  ${miss.file}:${miss.line} ${JSON.stringify(miss.raw)} [${miss.bucket}] — ${why}`;
  });
}

// Exit non-zero on anything RUN 1 says is a defect, so this can gate as well as report. A
// knownGap is not a defect; a STALE one is, because the debt was settled and the record
// still claims it. ⚠️ Run 2's misses do not fail this command: each is a named line in the
// published result (R179), and a gate that is red by design is a gate people route around.
// A stale gap on run 2 DOES, because it is the one run that can retire a detection gap.
const defects =
  run1.findings.filter((item) => !NON_DEFECT_KINDS.includes(item.kind)).length +
  run1.unkeyed.length +
  run2.findings.filter((item) => item.kind === 'stale-known-gap').length;
if (defects > 0) {
  process.stdout.write(`\n🔴 ${defects} finding(s) above. Read them; they are not a score.\n`);
  process.exit(1);
}
process.stdout.write(
  '\n✅ Run 1: every keyed entry matched its expected outcome, or carries a knownGap.\n',
);
for (const spot of blindSpots()) void spot; // rendered above; kept reachable for the linter

function posix(path) {
  return path.replace(/\\/g, '/');
}

function relativeTo(base, absolute) {
  const normalisedBase = posix(base).replace(/\/$/, '');
  const normalised = posix(absolute);
  return normalised.startsWith(`${normalisedBase}/`)
    ? normalised.slice(normalisedBase.length + 1)
    : normalised;
}
