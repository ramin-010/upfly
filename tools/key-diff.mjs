#!/usr/bin/env node
// @ts-check
/**
 * Proves that a change to the coverage tree's answer key touched only its prose. Entries are
 * matched on their file's path, `raw`, `occurrence` and `shape`, and every other field must be
 * identical, in the same order. Prose fields may be reworded but not added or removed, because
 * the key check reads their presence (a `knownGap`, an `absent` reason).
 *
 * Usage: `node tools/key-diff.mjs [--base <rev>] [--head <rev>] [--root <dir>]`. Without
 * `--head` the working tree is compared with `--base`, which defaults to `HEAD`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INTERNAL_REFERENCE, URL_PATTERN } from './comment-check.mjs';

export const KEY_FILE = 'coverage-tree/key/coverage-key.json';

/**
 * Where prose lives, as paths with `*` for any array index or object key.
 * Everything else in the key is data the suite's tools read.
 */
export const PROSE_FIELDS = [
  'what',
  'authored',
  'neverAScore',
  'imageSizesNote',
  'expectSemantics.*',
  'servingRoots.*.why',
  'notServingRoots.*.why',
  'aliases._',
  'shapes.*.motivation',
  'shapes.*.singleReason',
  'shapes.*.absent',
  'assets.*.note',
  'files.*.entries.*.why',
  'files.*.entries.*.knownGap',
];

/**
 * @typedef {unknown} Json parsed JSON
 * @typedef {{ field: string, before: string, after: string }} ProseChange
 * @typedef {{ problems: string[], prose: ProseChange[] }} Comparison
 */

/**
 * Compares two versions of the key.
 *
 * @param {Json} before
 * @param {Json} after
 * @returns {Comparison} `problems` is empty when only prose changed
 */
export function compareKeys(before, after) {
  /** @type {string[]} */
  const problems = [];
  /** @type {ProseChange[]} */
  const prose = [];
  compareEntries(before, after, problems);
  walk(before, after, [], problems, prose);
  return { problems, prose };
}

/**
 * The entries matched on file path, `raw`, `occurrence` and `shape`: none may appear,
 * disappear or move.
 *
 * @param {Json} before
 * @param {Json} after
 * @param {string[]} problems
 */
function compareEntries(before, after, problems) {
  const oldKeys = entryKeys(before);
  const newKeys = entryKeys(after);
  const oldSet = new Set(oldKeys);
  const newSet = new Set(newKeys);
  for (const key of oldKeys) if (!newSet.has(key)) problems.push(`entry removed: ${key}`);
  for (const key of newKeys) if (!oldSet.has(key)) problems.push(`entry added: ${key}`);
  if (problems.length === 0 && oldKeys.join('\n') !== newKeys.join('\n')) {
    problems.push('entries were reordered');
  }
}

/** @param {Json} key @returns {string[]} */
function entryKeys(key) {
  const files = isObject(key) && Array.isArray(key.files) ? key.files : [];
  return files.flatMap((file) => {
    if (!isObject(file) || !Array.isArray(file.entries)) return [];
    return file.entries.map((entry) => {
      const e = isObject(entry) ? entry : {};
      return JSON.stringify([file.path, e.raw, e.occurrence, e.shape]);
    });
  });
}

/**
 * Walks both versions together. Prose may differ in wording; anything else must be equal.
 *
 * @param {Json | undefined} before
 * @param {Json | undefined} after
 * @param {string[]} at the path walked so far
 * @param {string[]} problems
 * @param {ProseChange[]} prose
 */
function walk(before, after, at, problems, prose) {
  if (isProse(at)) compareProse(before, after, at, problems, prose);
  else if (isObject(before) && isObject(after)) {
    const keys = Object.keys(before);
    if (keys.join('\n') !== Object.keys(after).join('\n')) {
      problems.push(`${at.join('.') || 'the key'}: fields differ (${keys.join(', ')} before)`);
      return;
    }
    for (const key of keys) walk(before[key], after[key], [...at, key], problems, prose);
  } else if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) {
      problems.push(`${at.join('.')}: ${before.length} items before, ${after.length} after`);
      return;
    }
    before.forEach((item, index) =>
      walk(item, after[index], [...at, String(index)], problems, prose),
    );
  } else if (before !== after) {
    problems.push(`${at.join('.')}: ${JSON.stringify(before)} became ${JSON.stringify(after)}`);
  }
}

/**
 * A prose field may be reworded, but must stay text and may not appear or disappear.
 *
 * @param {Json | undefined} before
 * @param {Json | undefined} after
 * @param {string[]} at
 * @param {string[]} problems
 * @param {ProseChange[]} prose
 */
function compareProse(before, after, at, problems, prose) {
  if (typeof before !== 'string' || typeof after !== 'string') {
    if (before !== after) problems.push(`${at.join('.')}: prose added, removed or not text`);
  } else if (before !== after) {
    prose.push({ field: fieldName(at), before, after });
  }
}

/** @param {readonly string[]} at */
function isProse(at) {
  return PROSE_FIELDS.some((field) => {
    const parts = field.split('.');
    return (
      parts.length === at.length && parts.every((part, index) => part === '*' || part === at[index])
    );
  });
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Internal references left in the key's prose, counted per field.
 *
 * @param {Json} key
 * @returns {Record<string, number>}
 */
export function referencesInProse(key) {
  /** @type {Record<string, number>} */
  const counts = {};
  /** @param {Json | undefined} value @param {string[]} at */
  const visit = (value, at) => {
    if (isProse(at)) {
      const text = typeof value === 'string' ? value.replace(URL_PATTERN, ' ') : '';
      const found = text.match(INTERNAL_REFERENCE)?.length ?? 0;
      const field = fieldName(at);
      if (found > 0) counts[field] = (counts[field] ?? 0) + found;
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...at, String(index)]));
    } else if (isObject(value)) {
      for (const [name, item] of Object.entries(value)) visit(item, [...at, name]);
    }
  };
  visit(key, []);
  return counts;
}

/** A path with its array indexes replaced by `*`. @param {readonly string[]} at */
function fieldName(at) {
  return at.map((part) => (/^\d+$/.test(part) ? '*' : part)).join('.');
}

/**
 * @param {{ root: string, base: string, head: string | null }} options
 * @returns {{ exitCode: number, output: string }}
 */
export function run({ root, base, head }) {
  const git = (/** @type {string[]} */ args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const before = JSON.parse(git(['show', `${base}:${KEY_FILE}`]));
  const after = JSON.parse(
    head === null
      ? readFileSync(path.join(root, KEY_FILE), 'utf8')
      : git(['show', `${head}:${KEY_FILE}`]),
  );
  const { problems, prose } = compareKeys(before, after);
  /** @type {Record<string, number>} */
  const changed = {};
  for (const { field } of prose) changed[field] = (changed[field] ?? 0) + 1;
  const lines = [
    `Key diff: ${base} to ${head ?? 'the working tree'}, ${entryKeys(before).length} entries matched on path, raw, occurrence and shape.`,
    `Prose changed: ${
      Object.entries(changed)
        .map(([field, n]) => `${field} ${n}`)
        .join(', ') || 'none'
    }.`,
    `Internal references in prose: before ${total(referencesInProse(before))}, after ${total(referencesInProse(after))}.`,
    ...problems.map((problem) => `  ${problem}`),
    problems.length === 0
      ? 'Every entry and every other field is identical.'
      : `${problems.length} differences outside the prose.`,
  ];
  return { exitCode: problems.length === 0 ? 0 : 1, output: `${lines.join('\n')}\n` };
}

/** @param {Record<string, number>} counts */
function total(counts) {
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}

/**
 * @param {readonly string[]} argv
 * @returns {{ root: string, base: string, head: string | null } | string}
 */
export function parseArgs(argv) {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let base = 'HEAD';
  /** @type {string | null} */
  let head = null;
  for (let i = 0; i < argv.length; i += 2) {
    const [arg, value] = [argv[i], argv[i + 1]];
    if (value === undefined) return `${arg} needs a value`;
    if (arg === '--base') base = value;
    else if (arg === '--head') head = value;
    else if (arg === '--root') root = path.resolve(value);
    else return `unknown argument: ${arg}`;
  }
  return { root, base, head };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  if (typeof options === 'string') {
    process.stderr.write(`key-diff: ${options}\n`);
    process.exit(2);
  }
  const result = run(options);
  (result.exitCode === 0 ? process.stdout : process.stderr).write(result.output);
  process.exit(result.exitCode);
}
