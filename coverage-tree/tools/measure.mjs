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
 * Usage:  node tools/measure.mjs [--root DIR] [--key PATH] [--skip-strict]
 *         --skip-strict is for debugging the harness itself and prints a loud warning.
 *         It must never be used to produce a number anybody quotes.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NON_DEFECT_KINDS, blindSpots, buildMatrix, renderMatrix, toCodeUnits } from './matrix.mjs';

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
// 🔴 THE KEY'S OWN `servingRoots`, DECLARED — NOT `detectServingRoots`, AND THIS WAS A
// REAL BUG IN THE FIRST RUN OF THIS HARNESS. Auto-detection matches directories NAMED
// `public` or `static`, and the key declares four roots of which `sites/root-served` is
// R63's shape: a site whose OWN directory is the serving root. No name-based detector can
// find it, so four references came out `broken` and the matrix reported them as engine
// defects. **The engine was misconfigured by the instrument measuring it** — which is
// R49's cost, arriving inside the thing built to measure correctness, and the reason the
// key states its configuration in the first place.
//
// ⚠️ `declared: true` deliberately: the key IS the project stating this. Whether the
// engine can INFER these roots is R71's question and a different instrument's job; a
// matrix that conflated the two would blame detection for a reader's gap and vice versa.
// ⚠️ And `notServingRoots` is honoured by omission: `docs-examples/public` is named
// `public` and serves nothing, so auto-detection would claim it and the key says it must
// not be claimed.
const declaredRoots = {
  dirs: key.servingRoots.map((entry) => entry.path),
  declared: true,
};
const references = resolveReferences(scanned.references, {
  root: discovery.root,
  assets: discovery.assets,
  servingRoots: declaredRoots,
  excludedRoots: discovery.excludedRoots,
  aliases,
  exists: (path) => existsSync(path),
});

// ---- one observation per keyed file --------------------------------------------
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

const byFile = new Map();
for (const reference of references) {
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

const observed = new Map();
for (const group of key.files) {
  // R84. The key counts BYTES and the engine counts UTF-16 CODE UNITS. They agree on
  // ASCII and diverge silently otherwise — one em dash shifts every later offset by 2 —
  // so the key's offsets are converted here, before any join, and never the reverse.
  const bytes = readFileSync(join(root, group.path));
  for (const entry of group.entries) entry.offset = toCodeUnits(bytes, entry.offset);

  observed.set(group.path, {
    path: group.path,
    threw: threwBy.get(group.path) ?? null,
    references: byFile.get(group.path) ?? [],
  });
}

const result = buildMatrix(key, observed, { declarationOf: (id) => shapeById(id) });
process.stdout.write(`${renderMatrix(result, { emissionOf: (id) => shapeById(id)?.emission })}\n`);

// Exit non-zero on anything the tree says is a defect, so this can gate as well as
// report. A knownGap is not a defect; a STALE one is, because the debt was settled and
// the record still claims it.
const defects =
  result.findings.filter((item) => !NON_DEFECT_KINDS.includes(item.kind)).length +
  result.unkeyed.length;
if (defects > 0) {
  process.stdout.write(`\n🔴 ${defects} finding(s) above. Read them; they are not a score.\n`);
  process.exit(1);
}
process.stdout.write(
  '\n✅ Every keyed entry matched its expected outcome, or carries a knownGap.\n',
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
