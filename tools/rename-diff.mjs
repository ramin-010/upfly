#!/usr/bin/env node
// @ts-check
/**
 * Proves that a move changed nothing but where files are. `--from <old> --to <new>` proves a
 * folder renamed whole (`run`); `--move <old>=<new>`, once per file, proves files moved
 * between folders along with the paths that name them (`runMoves`).
 *
 * Usage: `node tools/rename-diff.mjs (--from <old> --to <new> | --move <old>=<new>...)
 * [--keep-names] [--mirror <source>=<output>] [--base <rev>] [--head <rev>] [--root <dir>]`.
 * Without `--head` the index is compared with `--base`, which defaults to `HEAD`, so it runs
 * once the move is staged.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * Whether `after` is `before` with the old folder name replaced by the new one wherever it is
 * a whole path segment: `'old-name/key'` and `'../old-name'` change, while `old-name:check`
 * and `10-old-name-spec.md` must stay as they are.
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
 * A folder renamed whole. Git must see every moved file as a rename, and every moved file
 * must keep its mode and bytes: the two folders' listings are compared path by path, so the
 * proof does not rest on how git pairs renames. Any other file may change only where the old
 * name is a whole path segment, and only to the new name, line for line.
 *
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

// ---- files moved between folders ----------------------------------------------------------

/**
 * @typedef {{ root: string, base: string, head: string | null }} Revisions
 * @typedef {Revisions & { mode: 'folder', from: string, to: string }} FolderOptions
 * @typedef {Revisions & { mode: 'moves', moves: Map<string, string>,
 *   mirrors: Array<[string, string]>, keepNames: boolean }} MoveOptions
 * @typedef {{ key: string, raw: string, line: number, path: 'import' | 'other' | null }} Item
 * @typedef {{ item: Item } | { imports: Item[][] }} Unit
 * @typedef {{ importPaths: number, otherPaths: number, importBlocks: number,
 *   textLines: number }} Tally
 * @typedef {{ side: 'old', paths: Map<string, string> } | { side: 'new', targets: Set<string> }}
 *   Side
 */

const CODE_EXTENSION = /\.(?:ts|mts|cts|tsx|js|mjs|cjs|jsx)$/;
// The formatter adds a comma before one of these when it breaks a list over several lines.
const CLOSERS = new Set([')', ']', '}']);
// Calls whose string arguments, one after another, are the segments of a single path.
const PATH_JOINERS = new Set(['join', 'resolve']);

/**
 * Proves that moving files changed nothing but where they are and the paths that name them.
 * Git must see each move as a rename, with no other file added, deleted or renamed, and each
 * moved file keeps its mode. A changed file of code, moved or not, must hold the same tokens
 * and comments in the same order, with two exceptions: a string naming a path may change if
 * it still reaches the same place from where its file now is, and a run of imports may be
 * re-sorted, since the formatter orders imports by path. Any other file may change only where
 * a moved file's whole path appears, and only to its new path. With `keepNames` a renamed
 * file fails. A mirror says a build writes each file under a source folder to the same place
 * under an output folder, so a path to the built file moves with its source.
 *
 * @param {MoveOptions} options
 * @returns {{ exitCode: number, output: string }}
 */
export function runMoves({ root, moves, mirrors, keepNames, base, head }) {
  const git = (/** @type {string[]} */ args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const read = (/** @type {string} */ spec) =>
    execFileSync('git', ['show', spec], { cwd: root, maxBuffer: 256 * 1024 * 1024 });

  const seen = whatGitSeesOfMoves(
    git(['diff', '--name-status', '-z', '-M', '-l0', ...range(base, head)]),
    moves,
  );
  const problems = [...seen.problems];
  const renamed = [...moves].filter(([from, to]) => baseName(from) !== baseName(to));
  if (keepNames) problems.push(...renamed.map(([from, to]) => `renamed: ${from} -> ${to}`));
  const modesAfter =
    head === null
      ? git(['ls-files', '-s', '-z', '--', ...moves.values()])
      : git(['ls-tree', '-r', '-z', head, '--', ...moves.values()]);
  problems.push(
    ...modeChanges(
      moves,
      modesOf(git(['ls-tree', '-r', '-z', base, '--', ...moves.keys()])),
      modesOf(modesAfter),
    ),
  );

  const paths = pathsMoved(moves, mirrors);
  /** @type {Tally} */
  const tally = { importPaths: 0, otherPaths: 0, importBlocks: 0, textLines: 0 };
  let identical = 0;
  for (const [oldFile, newFile] of [...seen.renamed, ...seen.modified.map((f) => pair(f, f))]) {
    const oldBytes = read(`${base}:${oldFile}`);
    const newBytes = read(head === null ? `:${newFile}` : `${head}:${newFile}`);
    if (oldBytes.equals(newBytes)) {
      if (oldFile !== newFile) identical += 1;
    } else {
      problems.push(...compareFile(oldBytes, newBytes, { oldFile, newFile }, paths, tally));
    }
  }

  const output = [
    `Move diff: ${moves.size} moves, ${base} to ${head ?? 'the index'}.`,
    `Moved: ${moves.size} files, ${seen.renamed.length} renames git sees, ` +
      `${moves.size - renamed.length} keep their names, ${identical} of ${moves.size} identical.`,
    `Other changed files: ${seen.modified.length}.`,
    `Paths changed that reach the same place: ${tally.importPaths} in imports, ` +
      `${tally.otherPaths} elsewhere. Import runs re-sorted: ${tally.importBlocks}. ` +
      `Lines of text with a moved path: ${tally.textLines}.`,
    ...problems.map((problem) => `  ${problem}`),
    problems.length === 0
      ? 'Nothing changed but where the files are and the paths that name them.'
      : `${problems.length} changes the moves do not explain.`,
  ];
  return { exitCode: problems.length === 0 ? 0 : 1, output: `${output.join('\n')}\n` };
}

/**
 * What git sees, from `diff --name-status -z -M`: each move a rename, and any other file only
 * modified.
 *
 * @param {string} text
 * @param {Map<string, string>} moves
 */
function whatGitSeesOfMoves(text, moves) {
  const fields = text.split('\0');
  const targets = new Set(moves.values());
  /** @type {Array<[string, string]>} */
  const renamed = [];
  /** @type {string[]} */
  const modified = [];
  /** @type {string[]} */
  const problems = [];
  for (let i = 0; i < fields.length - 1; ) {
    const status = fields[i] ?? '';
    if (status.startsWith('R')) {
      const [oldPath, newPath] = [fields[i + 1] ?? '', fields[i + 2] ?? ''];
      i += 3;
      if (moves.get(oldPath) === newPath) renamed.push(pair(oldPath, newPath));
      else problems.push(`renamed outside the moves: ${oldPath} -> ${newPath}`);
      continue;
    }
    const file = fields[i + 1] ?? '';
    i += 2;
    if (status === 'M' && !moves.has(file) && !targets.has(file)) modified.push(file);
    else problems.push(`${status === 'M' ? 'modified' : `status ${status}`}: ${file}`);
  }
  const seenMoves = new Set(renamed.map(([oldPath]) => oldPath));
  for (const [from, to] of moves) {
    if (!seenMoves.has(from)) problems.push(`git does not see a rename: ${from} -> ${to}`);
  }
  return { renamed, modified, problems };
}

/**
 * @param {Map<string, string>} moves
 * @param {Map<string, string>} before
 * @param {Map<string, string>} after
 */
function modeChanges(moves, before, after) {
  return [...moves]
    .filter(([from, to]) => {
      const [was, is] = [before.get(from), after.get(to)];
      return was !== undefined && is !== undefined && was !== is;
    })
    .map(([, to]) => `mode changed: ${to}`);
}

/**
 * One changed file: code unit by unit, anything else line by line.
 *
 * @param {Buffer} oldBytes
 * @param {Buffer} newBytes
 * @param {{ oldFile: string, newFile: string }} files
 * @param {Map<string, string>} paths
 * @param {Tally} tally
 * @returns {string[]}
 */
function compareFile(oldBytes, newBytes, { oldFile, newFile }, paths, tally) {
  if (oldBytes.includes(0) || newBytes.includes(0)) return [`${newFile}: a binary file changed`];
  const [oldText, newText] = [oldBytes.toString('utf8'), newBytes.toString('utf8')];
  if (!CODE_EXTENSION.test(newFile)) return compareText(oldText, newText, newFile, paths, tally);
  return compareCode(
    { text: oldText, file: oldFile },
    { text: newText, file: newFile },
    paths,
    tally,
  );
}

/**
 * Each file's mode by path, from `ls-tree -r -z` or `ls-files -s -z`, which both start a
 * record with it.
 *
 * @param {string} text
 * @returns {Map<string, string>}
 */
function modesOf(text) {
  /** @type {Map<string, string>} */
  const modes = new Map();
  for (const record of text.split('\0')) {
    if (record === '') continue;
    modes.set(record.slice(record.indexOf('\t') + 1), record.slice(0, record.indexOf(' ')));
  }
  return modes;
}

/**
 * Every path the moves change: each moved file's, and under a mirror, the built file's.
 *
 * @param {Map<string, string>} moves
 * @param {ReadonlyArray<[string, string]>} mirrors
 * @returns {Map<string, string>}
 */
function pathsMoved(moves, mirrors) {
  const paths = new Map(moves);
  for (const [from, to] of moves) {
    for (const [source, output] of mirrors) {
      if (!within(from, source) || !within(to, source)) continue;
      for (const extension of ['.js', '.d.ts']) {
        const built = (/** @type {string} */ file) =>
          `${output}${file.slice(source.length).replace(/\.ts$/, extension)}`;
        paths.set(built(from), built(to));
      }
    }
  }
  return paths;
}

/**
 * A file that is not code, line by line: each changed line must be the old one with every
 * moved path that stands whole replaced by its new path.
 *
 * @param {string} oldText
 * @param {string} newText
 * @param {string} file
 * @param {Map<string, string>} paths
 * @param {Tally} tally
 * @returns {string[]}
 */
function compareText(oldText, newText, file, paths, tally) {
  const [oldLines, newLines] = [oldText.split('\n'), newText.split('\n')];
  if (oldLines.length !== newLines.length) {
    return [`${file}: ${oldLines.length} lines became ${newLines.length}`];
  }
  const escaped = [...paths.keys()]
    .sort((a, b) => b.length - a.length)
    .map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const whole = new RegExp(`(?<![\\w./-])(?:${escaped.join('|')})(?![\\w/-])`, 'g');
  /** @type {string[]} */
  const problems = [];
  oldLines.forEach((line, index) => {
    const newLine = newLines[index] ?? '';
    if (line === newLine) return;
    tally.textLines += 1;
    if (line.replace(whole, (found) => paths.get(found) ?? found) !== newLine) {
      problems.push(`${file}:${index + 1}\n    - ${line}\n    + ${newLine}`);
    }
  });
  return problems;
}

/**
 * A file of code, before and after, compared unit by unit (see `codeUnits`). A string counts
 * as unchanged when its text is, or when it reaches the same place.
 *
 * @param {{ text: string, file: string }} before
 * @param {{ text: string, file: string }} after
 * @param {Map<string, string>} paths
 * @param {Tally} tally
 * @returns {string[]}
 */
function compareCode(before, after, paths, tally) {
  const oldUnits = codeUnits(before.text, before.file, { side: 'old', paths });
  const newUnits = codeUnits(after.text, after.file, {
    side: 'new',
    targets: new Set(paths.values()),
  });
  const count = Math.max(oldUnits.length, newUnits.length);
  for (let i = 0; i < count; i += 1) {
    if (!sameUnit(oldUnits[i], newUnits[i], tally)) {
      const near = (/** @type {Unit[]} */ units) => units.slice(i, i + 6).flatMap(itemsOf);
      return [mismatch(after.file, near(oldUnits), near(newUnits))];
    }
  }
  return [];
}

/**
 * @param {Unit | undefined} a
 * @param {Unit | undefined} b
 * @param {Tally} tally
 */
function sameUnit(a, b, tally) {
  if (a !== undefined && b !== undefined && 'item' in a && 'item' in b) {
    if (a.item.raw === b.item.raw) return true;
    if (a.item.key !== b.item.key || b.item.path === null) return false;
    if (b.item.path === 'import') tally.importPaths += 1;
    else tally.otherPaths += 1;
    return true;
  }
  if (a === undefined || b === undefined || !('imports' in a) || !('imports' in b)) return false;
  const [left, right] = [sortedByKey(a.imports), sortedByKey(b.imports)];
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    const [x = [], y = []] = [left[i], right[i]];
    if (keyOf(x) !== keyOf(y)) return false;
    x.forEach((item, j) => {
      const other = y[j];
      if (other !== undefined && item.raw !== other.raw && other.path === 'import') {
        tally.importPaths += 1;
      }
    });
  }
  if (a.imports.map(keyOf).join('\n') !== b.imports.map(keyOf).join('\n')) {
    tally.importBlocks += 1;
  }
  return true;
}

/**
 * A file of code as units to compare: each token and comment, except that each run of
 * imports is one unit holding a statement per import, with the comments above it.
 *
 * @param {string} text
 * @param {string} file
 * @param {Side} side
 * @returns {Unit[]}
 */
function codeUnits(text, file, side) {
  const sourceFile = ts.createSourceFile(
    file,
    text.replace(/\r\n?/g, '\n'),
    ts.ScriptTarget.Latest,
    true,
    scriptKind(file),
  );
  const items = codeItems(sourceFile, (value) => pathTarget(value, file, side));
  /** @type {Unit[]} */
  const units = [];
  let index = 0;
  for (const run of importRuns(sourceFile)) {
    for (; index < items.length && (items[index]?.pos ?? 0) < run.start; index += 1) {
      units.push({ item: at(items, index).item });
    }
    /** @type {Item[][]} */
    const statements = run.statements.map(() => []);
    for (; index < items.length && (items[index]?.pos ?? 0) < run.end; index += 1) {
      const { pos, item } = at(items, index);
      const owner = run.statements.findIndex((span) => pos >= span.start && pos < span.end);
      statements[owner]?.push(item);
    }
    units.push({ imports: statements });
  }
  for (; index < items.length; index += 1) units.push({ item: at(items, index).item });
  return units;
}

/**
 * Each run of imports next to each other at the top level, with each import's span. A span
 * starts where the statement before it ends, so the comments above an import travel with it,
 * as the formatter moves them; the file's first statement leaves those above it in place.
 *
 * @param {ts.SourceFile} sourceFile
 */
function importRuns(sourceFile) {
  /** @type {Array<{ start: number, end: number, statements: Array<{ start: number, end: number }> }>} */
  const runs = [];
  let open = false;
  sourceFile.statements.forEach((statement, index) => {
    if (!isImportLike(statement)) {
      open = false;
      return;
    }
    const start = index === 0 ? statement.getStart(sourceFile) : statement.getFullStart();
    const span = { start, end: statement.getEnd() };
    const current = runs[runs.length - 1];
    if (open && current !== undefined) {
      current.end = span.end;
      current.statements.push(span);
    } else {
      runs.push({ start, end: span.end, statements: [span] });
      open = true;
    }
  });
  return runs;
}

/**
 * Every token and comment in order, whitespace aside. A string naming a path is keyed by the
 * place it reaches, and so are strings given together to `join` or `resolve`: in
 * `join(here, '..', 'dist', 'a.js')` they are the one path `../dist/a.js`. A comma the
 * formatter adds before a closing bracket is left out.
 *
 * @param {ts.SourceFile} sourceFile
 * @param {(value: string) => string | null} targetOf
 * @returns {Array<{ pos: number, item: Item }>}
 */
function codeItems(sourceFile, targetOf) {
  const text = sourceFile.text;
  const segments = segmentRuns(sourceFile);
  const lineAt = (/** @type {number} */ pos) =>
    sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
  /** @type {Array<{ pos: number, item: Item }>} */
  const items = [];
  let skipUntil = -1;
  for (const token of leafTokens(sourceFile)) {
    for (const comment of ts.getLeadingCommentRanges(text, token.getFullStart()) ?? []) {
      const raw = text.slice(comment.pos, comment.end);
      const item = { key: `comment ${raw}`, raw, line: lineAt(comment.pos), path: null };
      items.push({ pos: comment.pos, item });
    }
    const start = token.getStart(sourceFile);
    if (token.kind === ts.SyntaxKind.EndOfFileToken || start < skipUntil) continue;
    const run = segments.get(start);
    if (run !== undefined) {
      skipUntil = run.end;
      const raw = text.slice(start, run.end);
      items.push({
        pos: start,
        item: stringItem(run.value, raw, lineAt(start), 'other', targetOf),
      });
      continue;
    }
    const item = tokenItem(token, sourceFile, lineAt(start), targetOf);
    if (item !== null) items.push({ pos: start, item });
  }
  return items.filter(({ item }, index) => {
    if (item.key !== ',') return true;
    const next = items.slice(index + 1).find((entry) => !entry.item.key.startsWith('comment '));
    return next === undefined || !CLOSERS.has(next.item.key);
  });
}

/**
 * @param {ts.Node} token
 * @param {ts.SourceFile} sourceFile
 * @param {number} line
 * @param {(value: string) => string | null} targetOf
 * @returns {Item | null}
 */
function tokenItem(token, sourceFile, line, targetOf) {
  const raw = token.getText(sourceFile);
  if (ts.isStringLiteral(token) || ts.isNoSubstitutionTemplateLiteral(token)) {
    return stringItem(token.text, raw, line, isModuleName(token) ? 'import' : 'other', targetOf);
  }
  if (token.kind === ts.SyntaxKind.JsxText) {
    const words = raw.replace(/\s+/g, ' ').trim();
    return words === '' ? null : { key: `jsx ${words}`, raw: words, line, path: null };
  }
  return { key: raw, raw, line, path: null };
}

/**
 * @param {string} value
 * @param {string} raw
 * @param {number} line
 * @param {'import' | 'other'} kind
 * @param {(value: string) => string | null} targetOf
 * @returns {Item}
 */
function stringItem(value, raw, line, kind, targetOf) {
  const target = targetOf(value);
  return target === null
    ? { key: `string ${value}`, raw, line, path: null }
    : { key: `path ${target}`, raw, line, path: kind };
}

/**
 * Where a string that names a path leads, seen from the file that holds it: a relative path
 * from the file's folder, or a path from the root that the moves change. On the old side the
 * answer is where that place is once the moves are made. `null` for any other string.
 *
 * @param {string} value
 * @param {string} file
 * @param {Side} side
 * @returns {string | null}
 */
function pathTarget(value, file, side) {
  const relative = /^\.\.?(?:\/|$)/.test(value);
  const fromFile = () => path.posix.join(path.posix.dirname(file), value);
  if (side.side === 'new') {
    if (relative) return fromFile();
    return side.targets.has(value) ? value : null;
  }
  if (!relative && !side.paths.has(value)) return null;
  const target = relative ? fromFile() : value;
  const moved = side.paths.get(target);
  if (moved !== undefined) return moved;
  // An import names a TypeScript file by the `.js` file it compiles to.
  const source = target.endsWith('.js') ? side.paths.get(`${target.slice(0, -3)}.ts`) : undefined;
  return source === undefined ? target : `${source.slice(0, -3)}.js`;
}

/**
 * The strings given one after another to `join` or `resolve`, keyed by where each run starts.
 *
 * @param {ts.SourceFile} sourceFile
 * @returns {Map<number, { end: number, value: string }>}
 */
function segmentRuns(sourceFile) {
  /** @type {Map<number, { end: number, value: string }>} */
  const runs = new Map();
  /** @param {ts.StringLiteral[]} run */
  const record = (run) => {
    const [first, last] = [run[0], run[run.length - 1]];
    if (run.length < 2 || first === undefined || last === undefined) return;
    const value = run.map((literal) => literal.text).join('/');
    runs.set(first.getStart(sourceFile), { end: last.getEnd(), value });
  };
  /** @param {ts.Node} node */
  const visit = (node) => {
    if (ts.isCallExpression(node) && PATH_JOINERS.has(calleeName(node.expression))) {
      /** @type {ts.StringLiteral[]} */
      let run = [];
      for (const argument of node.arguments) {
        if (ts.isStringLiteral(argument)) {
          run.push(argument);
        } else {
          record(run);
          run = [];
        }
      }
      record(run);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return runs;
}

/**
 * The file's tokens in order. A JSDoc comment is read as a comment, from the text around the
 * token after it, never as the parts the parser makes of it.
 *
 * @param {ts.SourceFile} sourceFile
 * @returns {ts.Node[]}
 */
function leafTokens(sourceFile) {
  /** @type {ts.Node[]} */
  const tokens = [];
  /** @type {ts.Node[]} */
  const stack = [sourceFile];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    const kind = node.kind;
    if (kind >= ts.SyntaxKind.FirstJSDocNode && kind <= ts.SyntaxKind.LastJSDocNode) continue;
    if (kind > ts.SyntaxKind.LastToken) {
      // A copy: `getChildren` returns the parser's cached array.
      stack.push(...[...node.getChildren(sourceFile)].reverse());
    } else if (node.pos !== node.end || kind === ts.SyntaxKind.EndOfFileToken) {
      tokens.push(node);
    }
  }
  return tokens;
}

/** @param {ts.Statement} statement */
function isImportLike(statement) {
  return (
    ts.isImportDeclaration(statement) ||
    (ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined) ||
    (ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference))
  );
}

/**
 * Whether a string is the module an import, an export, `import()` or `require()` names.
 *
 * @param {ts.StringLiteral | ts.NoSubstitutionTemplateLiteral} literal
 */
function isModuleName(literal) {
  const parent = literal.parent;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return true;
  if (ts.isExternalModuleReference(parent)) return true;
  if (ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent)) return true;
  if (!ts.isCallExpression(parent)) return false;
  const callee = parent.expression;
  return (
    callee.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(callee) && callee.text === 'require')
  );
}

/** @param {ts.Expression} expression */
function calleeName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return '';
}

/** @param {Item[][]} statements */
function sortedByKey(statements) {
  return [...statements].sort((a, b) => {
    const [x, y] = [keyOf(a), keyOf(b)];
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

/** @param {Item[]} items */
function keyOf(items) {
  return items.map((item) => item.key).join('\u0000');
}

/** @param {Unit} unit */
function itemsOf(unit) {
  return 'item' in unit ? [unit.item] : unit.imports.flat();
}

/**
 * @param {string} file
 * @param {Item[]} before
 * @param {Item[]} after
 */
function mismatch(file, before, after) {
  const shown = (/** @type {Item[]} */ items) =>
    items
      .map((item) => item.raw)
      .join(' ')
      .slice(0, 160);
  const line = after[0]?.line ?? before[0]?.line ?? 0;
  return `${file}:${line}\n    - ${shown(before)}\n    + ${shown(after)}`;
}

/**
 * @template T
 * @param {readonly T[]} array
 * @param {number} index
 * @returns {T}
 */
function at(array, index) {
  const value = array[index];
  if (value === undefined) throw new Error(`no entry at ${index}`);
  return value;
}

/** @param {string} file */
function baseName(file) {
  return path.posix.basename(file);
}

/** @param {string} file */
function scriptKind(file) {
  if (/\.[cm]?jsx?$/.test(file)) return file.endsWith('x') ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
  return file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

const SINGLE = new Set(['--from', '--to', '--base', '--head', '--root']);
const PAIRED = new Set(['--move', '--mirror']);

/**
 * @param {readonly string[]} argv
 * @returns {FolderOptions | MoveOptions | string}
 */
export function parseArgs(argv) {
  const read = readArgs(argv);
  if (typeof read === 'string') return read;
  const { single, paired, keepNames } = read;
  const folder = (/** @type {string} */ name) => (single.get(name) ?? '').replace(/\/+$/, '');
  const revisions = {
    root: path.resolve(
      single.get('--root') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
    ),
    base: single.get('--base') ?? 'HEAD',
    head: single.get('--head') ?? null,
  };
  const moves = new Map(paired.get('--move'));
  const mirrors = (paired.get('--mirror') ?? []).map(([from, to]) =>
    pair(from.replace(/\/+$/, ''), to.replace(/\/+$/, '')),
  );
  const [from, to] = [folder('--from'), folder('--to')];
  if (moves.size > 0) {
    if (from !== '' || to !== '') return '--move cannot be combined with --from and --to';
    return { mode: 'moves', ...revisions, moves, mirrors, keepNames };
  }
  if (mirrors.length > 0 || keepNames) return '--mirror and --keep-names need --move';
  if (from === '' || to === '') return '--from and --to are both needed, or --move';
  return { mode: 'folder', ...revisions, from, to };
}

/**
 * The arguments as given: each single value by flag, each `<old>=<new>` pair by flag.
 *
 * @param {readonly string[]} argv
 */
function readArgs(argv) {
  /** @type {Map<string, string>} */
  const single = new Map();
  /** @type {Map<string, Array<[string, string]>>} */
  const paired = new Map();
  let keepNames = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--keep-names') {
      keepNames = true;
      continue;
    }
    const value = argv[i + 1];
    i += 1;
    if (value === undefined) return `${arg} needs a value`;
    if (SINGLE.has(arg)) {
      single.set(arg, value);
      continue;
    }
    if (!PAIRED.has(arg)) return `unknown argument: ${arg}`;
    const [left = '', right = '', ...rest] = value.split('=');
    if (left === '' || right === '' || rest.length > 0) {
      return `${arg} takes <old>=<new>, not ${value}`;
    }
    paired.set(arg, [...(paired.get(arg) ?? []), pair(left, right)]);
  }
  return { single, paired, keepNames };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  if (typeof options === 'string') {
    process.stderr.write(`rename-diff: ${options}\n`);
    process.exit(2);
  }
  const result = options.mode === 'moves' ? runMoves(options) : run(options);
  (result.exitCode === 0 ? process.stdout : process.stderr).write(result.output);
  process.exit(result.exitCode);
}
