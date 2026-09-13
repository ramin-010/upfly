/**
 * THE SELF-CHECK. Run it BEFORE anything measures this tree.
 *
 * 🔴 It uses plain text search and path arithmetic, and NOTHING ELSE. It does not import
 * upfly-core, does not call the resolver, and does not know that an engine exists.
 * Certifying the answer key with the engine the key exists to measure is R72 — the
 * instrument confirming its own blind spots — and it is the single defect that would make
 * this whole tree worthless while still reading green.
 *
 * A key/tree disagreement is a BROKEN INSTRUMENT, not a finding. This exits non-zero and
 * the suite stops before it measures anything.
 *
 * What it proves:
 *   1. every asset the key lists exists, at the recorded byte size and hash
 *   2. every asset on disk is listed
 *   3. every reference's `raw` is present at the recorded byte offset, exactly
 *   4. the recorded line and column agree with the offset
 *   5. `expect` is a known outcome, and `target` is present exactly when it should be
 *   6. a RELATIVE reference expecting `resolved` actually lands on its declared target,
 *      by path arithmetic alone
 *   7. every occurrence in the tree is accounted for by the key
 *   8. every shape has instances, or says in writing why it has none
 *
 * Usage:  node tools/check-key.mjs [--root DIR] [--key PATH] [--strict] [--quiet]
 *         --strict also fails on UNDECIDED entries. The measuring suite runs strict.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { listAssetFiles, listTextFiles, scanFile } from './scan-occurrences.mjs';

const OUTCOMES = new Set([
  'resolved',
  'resolved-pattern',
  'dynamic',
  'out-of-scope',
  'unresolved-alias',
  'broken',
  'discarded',
  'UNDECIDED',
]);

const WANTS_TARGET = new Set(['resolved', 'resolved-pattern']);

const failures = [];
const undecided = [];
const fail = (where, message) => failures.push(`${where}: ${message}`);

function positionOf(buf, offset) {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i += 1) {
    if (buf[i] === 0x0a) {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

const here = resolve(process.argv[1], '..', '..');
const root = resolve(arg('--root', join(here, 'tree')));
const keyPath = resolve(arg('--key', join(here, 'key', 'coverage-key.json')));
const strict = process.argv.includes('--strict');
const quiet = process.argv.includes('--quiet');

/* -------------------------------------------------------------------------------------
 * 0. The checker must not be able to consult the engine. Prove it rather than promise it.
 * ----------------------------------------------------------------------------------- */
for (const tool of ['check-key.mjs', 'scan-occurrences.mjs']) {
  const source = readFileSync(join(here, 'tools', tool), 'utf8');
  const offending = source
    .split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /^\s*(import|export)\s.*\bfrom\s+['"]/.test(line))
    .filter(([, line]) => !/from\s+['"](node:|\.\/)/.test(line));
  for (const [lineNo, line] of offending) {
    fail(`${tool}:${lineNo}`, `the self-check may only import node: and ./ — found ${line.trim()}`);
  }
  // A mention of the engine in a comment is fine and is in fact the point. A dynamic
  // import or require of it is not, and would slip past the static-import check above.
  for (const [lineNo, line] of source.split('\n').map((l, i) => [i + 1, l])) {
    if (/\b(require|import)\s*\(\s*['"`]/.test(line) && !/['"`](node:|\.\/)/.test(line)) {
      fail(`${tool}:${lineNo}`, `a dynamic import that is not node: or ./ — ${line.trim()}`);
    }
  }
}

const key = JSON.parse(readFileSync(keyPath, 'utf8'));

/* -------------------------------------------------------------------------------------
 * 1 + 2. Assets: listed <-> on disk, byte for byte.
 * ----------------------------------------------------------------------------------- */
const listedAssets = new Map();
for (const asset of key.assets ?? []) {
  if (listedAssets.has(asset.path)) fail('assets', `listed twice: ${asset.path}`);
  listedAssets.set(asset.path, asset);
  let buf;
  try {
    buf = readFileSync(join(root, asset.path));
  } catch {
    fail('assets', `listed but not on disk: ${asset.path}`);
    continue;
  }
  if (asset.bytes !== buf.length) {
    fail('assets', `${asset.path}: key says ${asset.bytes} bytes, disk has ${buf.length}`);
  }
  const sha = createHash('sha256').update(buf).digest('hex').slice(0, 16);
  if (asset.sha256 !== sha) {
    fail('assets', `${asset.path}: key says sha256 ${asset.sha256}, disk has ${sha}`);
  }
}
for (const { path } of listAssetFiles(root)) {
  if (!listedAssets.has(path)) fail('assets', `on disk but not in the key: ${path}`);
}

/* -------------------------------------------------------------------------------------
 * 3 + 4 + 5 + 6. References.
 * ----------------------------------------------------------------------------------- */
const shapeUse = new Map();
const spansByFile = new Map();
const knownShapes = new Set((key.shapes ?? []).map((s) => s.id));
const textFiles = new Set(listTextFiles(root));

for (const group of key.files ?? []) {
  const where = group.path;
  if (!textFiles.has(group.path)) {
    fail(where, 'the key lists this file, but it is not a text file in the tree');
    continue;
  }
  const buf = readFileSync(join(root, group.path));
  const spans = [];
  spansByFile.set(group.path, spans);

  const seenRaw = new Map();
  for (const entry of group.entries ?? []) {
    const label = `${where} ${JSON.stringify(entry.raw)}#${entry.occurrence ?? 1}`;

    // 3. The bytes at the recorded offset are the recorded raw.
    const needle = Buffer.from(entry.raw, 'utf8');
    const actual = buf.subarray(entry.offset, entry.offset + needle.length);
    if (!actual.equals(needle)) {
      fail(
        label,
        `offset ${entry.offset} holds ${JSON.stringify(actual.toString('utf8'))}, not the recorded raw`,
      );
    }

    // 3b. And it really is the nth occurrence, so two entries cannot share one.
    //
    // ⚠️ Occurrence indices must INCREASE, but they need not start at 1 or run
    // consecutively. A raw that is a substring of a longer path elsewhere in the file
    // legitimately begins at occurrence 3 — `logo.png` is inside two longer paths above
    // it before it appears in a sentence of its own. Requiring 1, 2, 3 here would reject
    // a correct key for being honest about that.
    const n = entry.occurrence ?? 1;
    const previous = seenRaw.get(entry.raw);
    if (previous !== undefined && n <= previous) {
      fail(label, `occurrence ${n} does not come after ${previous} for this raw`);
    }
    seenRaw.set(entry.raw, n);
    let from = 0;
    let at = -1;
    for (let i = 0; i < n; i += 1) {
      at = buf.indexOf(needle, from);
      if (at === -1) break;
      from = at + 1;
    }
    if (at !== entry.offset) {
      fail(label, `occurrence ${n} of this raw is at ${at}, but the key records ${entry.offset}`);
    }

    // 4. Line and column agree with the offset.
    const pos = positionOf(buf, entry.offset);
    if (pos.line !== entry.line || pos.column !== entry.column) {
      fail(
        label,
        `offset ${entry.offset} is line ${pos.line} column ${pos.column}, ` +
          `but the key records line ${entry.line} column ${entry.column}`,
      );
    }

    spans.push([entry.offset, entry.offset + needle.length]);

    // 5. Outcome vocabulary and target presence.
    if (!OUTCOMES.has(entry.expect)) {
      fail(label, `unknown expect ${JSON.stringify(entry.expect)}`);
    }
    if (entry.expect === 'UNDECIDED') {
      undecided.push(`${label} — ${entry.why ?? '(no note)'}`);
      if (!Array.isArray(entry.candidates) || entry.candidates.length < 2) {
        fail(label, 'an UNDECIDED entry must list at least two candidate outcomes');
      }
    }
    const targets = entry.target === undefined ? [] : [].concat(entry.target);
    if (WANTS_TARGET.has(entry.expect) && targets.length === 0) {
      fail(label, `expect ${entry.expect} requires a target`);
    }
    if (!WANTS_TARGET.has(entry.expect) && targets.length > 0) {
      fail(label, `expect ${entry.expect} must not carry a target`);
    }
    if (entry.expect === 'resolved' && targets.length !== 1) {
      fail(label, 'resolved means exactly one target');
    }
    for (const target of targets) {
      if (!listedAssets.has(target) && !textFiles.has(target)) {
        fail(label, `target is neither a listed asset nor a file in the tree: ${target}`);
      }
    }

    // 6. Path arithmetic, for the relative forms where it is decidable without an engine.
    //    This is the check that catches a miscounted `../` climb, which is the error a
    //    human actually makes and cannot see by reading.
    if (entry.expect === 'resolved' && /^\.{1,2}\//.test(entry.raw)) {
      const dir = posix.dirname(group.path);
      const cleaned = entry.raw.replace(/[?#].*$/, '');
      const computed = posix.normalize(posix.join(dir, cleaned));
      if (computed !== targets[0]) {
        fail(label, `relative path resolves to ${computed}, but the key says ${targets[0]}`);
      }
    }

    // 8a. Shapes must be declared.
    if (!knownShapes.has(entry.shape)) {
      fail(label, `shape ${JSON.stringify(entry.shape)} is not declared in key.shapes`);
    }
    shapeUse.set(entry.shape, (shapeUse.get(entry.shape) ?? 0) + 1);
  }
}

/* -------------------------------------------------------------------------------------
 * 6b. No two references may overlap.
 *
 * ⚠️ This one is not obvious and it closes a real hole. When one raw is a substring of
 * another — `../../../x.png` inside `../../../../x.png`, or `/img/hero.jpg` inside
 * `/img/hero.jpg?v=3` — an occurrence index that is one too low makes the stamper record
 * a position INSIDE the longer reference. Every other check passes: the bytes match, the
 * line matches, and the containment rule counts the hit as accounted for. Only the
 * overlap is visible.
 * ----------------------------------------------------------------------------------- */
for (const [rel, spans] of spansByFile) {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i][0] < sorted[i - 1][1]) {
      fail(
        rel,
        `two references overlap at bytes ${sorted[i - 1][0]}-${sorted[i - 1][1]} and ` +
          `${sorted[i][0]}-${sorted[i][1]} — almost always an occurrence index one too low`,
      );
    }
  }
}

/* -------------------------------------------------------------------------------------
 * 7. Completeness: no occurrence may exist that the key does not list.
 *
 * A hit counts as accounted for when it falls inside a listed reference's span. That
 * containment rule is what lets a listed raw carry a space or a parenthesis, which the
 * token pattern cannot match through.
 * ----------------------------------------------------------------------------------- */
const allowlist = new Map();
for (const item of key.unreferencedOccurrences ?? []) {
  allowlist.set(`${item.file}@${item.offset}`, item);
}

let accounted = 0;
let total = 0;
for (const rel of textFiles) {
  const spans = spansByFile.get(rel) ?? [];
  for (const hit of scanFile(root, rel)) {
    total += 1;
    const inside = spans.some(([start, end]) => hit.offset >= start && hit.offset < end);
    if (inside) {
      accounted += 1;
      continue;
    }
    if (allowlist.has(`${rel}@${hit.offset}`)) {
      accounted += 1;
      continue;
    }
    fail(
      rel,
      `line ${hit.line} column ${hit.column} (offset ${hit.offset}) holds ` +
        `${JSON.stringify(hit.token)}, which the key does not list`,
    );
  }
}

/* -------------------------------------------------------------------------------------
 * 8b. Every declared shape has instances, or says why not.
 * ----------------------------------------------------------------------------------- */
for (const shape of key.shapes ?? []) {
  const count = shapeUse.get(shape.id) ?? 0;
  if (count === 0 && !shape.absent) {
    fail('shapes', `${shape.id} has no references and no \`absent\` reason`);
  }
  if (count === 1 && !shape.singleReason) {
    fail(
      'shapes',
      `${shape.id} has one instance. Spec 4k.1: a shape may only be recorded as 1 of 1 ` +
        'if varying it is genuinely impossible, and the key must say why (`singleReason`)',
    );
  }
}

/* ----------------------------------------------------------------------------------- */
const refCount = (key.files ?? []).reduce((n, g) => n + (g.entries ?? []).length, 0);

if (!quiet) {
  process.stdout.write('\ncoverage-tree self-check — plain text search only, no engine\n');
  process.stdout.write(`  key       ${keyPath}\n`);
  process.stdout.write(`  tree      ${root}\n`);
  process.stdout.write(`  assets    ${listedAssets.size} listed\n`);
  process.stdout.write(`  files     ${textFiles.size} text files scanned\n`);
  process.stdout.write(`  refs      ${refCount} listed\n`);
  process.stdout.write(`  shapes    ${knownShapes.size} declared\n`);
  process.stdout.write(`  occurrences ${accounted} of ${total} accounted for\n`);
}

if (undecided.length > 0) {
  process.stdout.write(`\nOPEN QUESTIONS — ${undecided.length} entr${undecided.length === 1 ? 'y' : 'ies'} marked UNDECIDED\n`);
  for (const line of undecided) process.stdout.write(`  ? ${line}\n`);
  process.stdout.write(
    strict
      ? '\n  --strict: an undecided entry is a question for a person, not a measurement.\n'
      : '\n  These do not fail the integrity check. The measuring suite runs --strict and will.\n',
  );
}

if (failures.length > 0) {
  process.stdout.write(`\nFAILED — ${failures.length} problem(s)\n\n`);
  for (const line of failures) process.stdout.write(`  x ${line}\n`);
  process.stdout.write('\nA key/tree disagreement is a broken instrument, not a finding.\n');
  process.stdout.write('Nothing may measure this tree until it agrees with its own key.\n');
  process.exitCode = 1;
} else if (strict && undecided.length > 0) {
  process.exitCode = 1;
} else {
  process.stdout.write('\nOK — the key and the tree agree.\n');
}
