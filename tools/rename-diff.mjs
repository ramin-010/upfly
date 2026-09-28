#!/usr/bin/env node
// @ts-check
/**
 * Proves that moving a folder changed nothing but the folder's name. Git must see every
 * moved file as a rename, and every moved file must keep its mode and bytes: the two folders'
 * listings are compared path by path, so the proof does not rest on how git pairs renames.
 * Any other file may change only where the old name is a whole path segment, and only to the
 * new name, line for line.
 *
 * Usage: `node tools/rename-diff.mjs --from <old> --to <new> [--base <rev>] [--head <rev>]
 * [--root <dir>]`. Without `--head` the index is compared with `--base`, which defaults to
 * `HEAD`, so it runs once both folders are staged.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Whether `after` is `before` with the old folder name replaced by the new one wherever it is
 * a whole path segment: `'coverage-tree/key'` and `'../coverage-tree'` change, while
 * `coverage-tree:check` and `10-coverage-tree-spec.md` must stay as they are.
 *
 * @param {string} before
 * @param {string} after
 * @param {string} from
 * @param {string} to
 */
export function explains(before, after, from, to) {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const segment = new RegExp(`(?<![\\w.-])${escaped}(?=[/'"\`])`, 'g');
  return before.replace(segment, to) === after;
}

/**
 * @param {{ root: string, from: string, to: string, base: string, head: string | null }} options
 * @returns {{ exitCode: number, output: string }}
 */
export function run({ root, from, to, base, head }) {
  const git = (/** @type {string[]} */ args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const read = (/** @type {string} */ spec) =>
    execFileSync('git', ['show', spec], { cwd: root, maxBuffer: 256 * 1024 * 1024 });

  const seen = whatGitSees(
    git(['diff', '--name-status', '-z', '-M', '-l0', ...range(base, head)]),
    from,
    to,
  );
  const before = listing(git(['ls-tree', '-r', '-z', base, '--', from]), from, 'tree');
  const after =
    head === null
      ? listing(git(['ls-files', '-s', '-z', '--', to]), to, 'index')
      : listing(git(['ls-tree', '-r', '-z', head, '--', to]), to, 'tree');
  const left =
    head === null
      ? git(['ls-files', '-z', '--', from])
      : git(['ls-tree', '-r', '-z', '--name-only', head, '--', from]);
  const folders = compareFolders(before, after, from, to);
  const lines = changedLines(
    [
      ...folders.changed.map((relative) => pair(`${from}/${relative}`, `${to}/${relative}`)),
      ...seen.modified.map((file) => pair(file, file)),
    ],
    (file) => read(`${base}:${file}`),
    (file) => read(head === null ? `:${file}` : `${head}:${file}`),
    from,
    to,
  );

  const problems = [...seen.problems, ...folders.problems, ...lines.problems];
  if (left !== '') problems.push(`${from} still holds files after the move`);
  if (seen.renames !== before.size) {
    problems.push(`git sees ${seen.renames} of the ${before.size} moved files as renames`);
  }
  const output = [
    `Rename diff: ${from} to ${to}, ${base} to ${head ?? 'the index'}.`,
    `Moved: ${before.size} files, ${seen.renames} renames git sees, ${before.size - folders.changed.length} of ${before.size} identical.`,
    `Other changed files: ${seen.modified.length}, with ${lines.count} changed lines between them and the moved files.`,
    ...problems.map((problem) => `  ${problem}`),
    problems.length === 0
      ? 'Nothing changed but the folder name.'
      : `${problems.length} changes the rename does not explain.`,
  ];
  return { exitCode: problems.length === 0 ? 0 : 1, output: `${output.join('\n')}\n` };
}

/**
 * What git sees, from `diff --name-status -z -M`: files under `from` renamed into `to`, and
 * any other file only modified.
 *
 * @param {string} text
 * @param {string} from
 * @param {string} to
 */
function whatGitSees(text, from, to) {
  const fields = text.split('\0');
  let renames = 0;
  /** @type {string[]} */
  const modified = [];
  /** @type {string[]} */
  const problems = [];
  for (let i = 0; i < fields.length - 1; ) {
    const status = fields[i] ?? '';
    if (status.startsWith('R')) {
      const [oldPath, newPath] = [fields[i + 1] ?? '', fields[i + 2] ?? ''];
      i += 3;
      if (within(oldPath, from) && within(newPath, to)) renames += 1;
      else problems.push(`renamed outside the move: ${oldPath} -> ${newPath}`);
      continue;
    }
    const file = fields[i + 1] ?? '';
    i += 2;
    if (status === 'M' && !within(file, from) && !within(file, to)) modified.push(file);
    else problems.push(`${status === 'M' ? 'modified' : `status ${status}`}: ${file}`);
  }
  return { renames, modified, problems };
}

/**
 * The two folders path by path: the same relative paths, modes and blobs.
 *
 * @param {Map<string, { mode: string, blob: string }>} before
 * @param {Map<string, { mode: string, blob: string }>} after
 * @param {string} from
 * @param {string} to
 */
function compareFolders(before, after, from, to) {
  /** @type {string[]} */
  const changed = [];
  /** @type {string[]} */
  const problems = [];
  for (const [relative, entry] of before) {
    const moved = after.get(relative);
    if (moved === undefined) problems.push(`not in ${to}: ${from}/${relative}`);
    else if (moved.mode !== entry.mode) problems.push(`mode changed: ${to}/${relative}`);
    else if (moved.blob !== entry.blob) changed.push(relative);
  }
  for (const relative of after.keys()) {
    if (!before.has(relative)) problems.push(`new in ${to}: ${to}/${relative}`);
  }
  return { changed, problems };
}

/**
 * Every changed line of each pair, which must be the old line with the folder renamed.
 *
 * @param {Array<[string, string]>} pairs Each an old path and a new path.
 * @param {(file: string) => Buffer} readOld
 * @param {(file: string) => Buffer} readNew
 * @param {string} from
 * @param {string} to
 */
function changedLines(pairs, readOld, readNew, from, to) {
  let count = 0;
  /** @type {string[]} */
  const problems = [];
  for (const [oldFile, newFile] of pairs) {
    const [oldBytes, newBytes] = [readOld(oldFile), readNew(newFile)];
    if (oldBytes.includes(0) || newBytes.includes(0)) {
      problems.push(`${newFile}: a binary file changed`);
      continue;
    }
    const oldLines = oldBytes.toString('utf8').split('\n');
    const newLines = newBytes.toString('utf8').split('\n');
    if (oldLines.length !== newLines.length) {
      problems.push(`${newFile}: ${oldLines.length} lines became ${newLines.length}`);
      continue;
    }
    oldLines.forEach((oldLine, index) => {
      const newLine = newLines[index] ?? '';
      if (oldLine === newLine) return;
      count += 1;
      if (!explains(oldLine, newLine, from, to)) {
        problems.push(`${newFile}:${index + 1}\n    - ${oldLine}\n    + ${newLine}`);
      }
    });
  }
  return { count, problems };
}

/**
 * @param {string} base
 * @param {string | null} head
 */
function range(base, head) {
  return head === null ? ['--cached', base] : [base, head];
}

/**
 * @param {string} oldPath
 * @param {string} newPath
 * @returns {[string, string]}
 */
function pair(oldPath, newPath) {
  return [oldPath, newPath];
}

/**
 * @param {string} file
 * @param {string} folder
 */
function within(file, folder) {
  return file.startsWith(`${folder}/`);
}

/**
 * A folder's files by path relative to it, from `ls-tree -r -z` or `ls-files -s -z`.
 *
 * @param {string} text
 * @param {string} folder
 * @param {'tree' | 'index'} source
 * @returns {Map<string, { mode: string, blob: string }>}
 */
function listing(text, folder, source) {
  /** @type {Map<string, { mode: string, blob: string }>} */
  const files = new Map();
  for (const record of text.split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    const [mode = '', second = '', third = ''] = record.slice(0, tab).split(' ');
    const blob = source === 'tree' ? third : second;
    files.set(record.slice(tab + 1).slice(folder.length + 1), { mode, blob });
  }
  return files;
}

/**
 * @param {readonly string[]} argv
 * @returns {{ root: string, from: string, to: string, base: string, head: string | null } | string}
 */
export function parseArgs(argv) {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let base = 'HEAD';
  /** @type {string | null} */
  let head = null;
  let from = '';
  let to = '';
  for (let i = 0; i < argv.length; i += 2) {
    const [arg, value] = [argv[i], argv[i + 1]];
    if (value === undefined) return `${arg} needs a value`;
    if (arg === '--from') from = value.replace(/\/+$/, '');
    else if (arg === '--to') to = value.replace(/\/+$/, '');
    else if (arg === '--base') base = value;
    else if (arg === '--head') head = value;
    else if (arg === '--root') root = path.resolve(value);
    else return `unknown argument: ${arg}`;
  }
  if (from === '' || to === '') return '--from and --to are both needed';
  return { root, from, to, base, head };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  if (typeof options === 'string') {
    process.stderr.write(`rename-diff: ${options}\n`);
    process.exit(2);
  }
  const result = run(options);
  (result.exitCode === 0 ? process.stdout : process.stderr).write(result.output);
  process.exit(result.exitCode);
}
