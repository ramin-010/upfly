#!/usr/bin/env node
// @ts-check
/**
 * Proves that a change touched only comments. Each changed source file is compared before
 * and after as a stream of tokens without comments or whitespace, and every difference is
 * printed. Three kinds are allowed and named: a test's title, a `why` string of the exported
 * `SHAPES` table, and a `bench/src` string that held an internal reference and no longer
 * does. Anything else fails the run, as does a change under a test-data folder or a source
 * file added or deleted. Tool directives and the types JSDoc declares in JavaScript count as
 * code. Layout the formatter changes with a line break is ignored: a comma before a closing
 * bracket, the leading `|` or `&` of a union, and parentheses around a returned value.
 *
 * Usage: `node tools/token-diff.mjs [--base <rev>] [--head <rev>] [--root <dir>] [<path>...]`
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { INTERNAL_REFERENCE, URL_PATTERN } from './comment-check.mjs';

/**
 * @typedef {'test-title' | 'shapes-why' | 'bench-string'} AllowedKind
 * @typedef {AllowedKind | 'code'} DifferenceKind
 * @typedef {{ key: string, text: string, line: number, unit: 'title' | 'why' | null, isString: boolean }} Token
 * @typedef {{ kind: DifferenceKind, before: Token[], after: Token[] }} Difference
 * @typedef {{ status: 'added' | 'deleted' | 'modified', file: string }} ChangedFile
 * @typedef {{ root: string, base: string, head: string | null, paths: string[] }} Options
 */

/** How each kind is named in the output. */
export const KIND_LABELS = /** @type {const} */ ({
  'test-title': 'test title',
  'shapes-why': 'SHAPES why',
  'bench-string': 'bench string',
  code: 'code change',
});

const SOURCE_EXTENSION = /\.(?:ts|mts|cts|tsx|js|mjs|cjs|jsx)$/;
const SHAPES_FILE = 'packages/core/src/shapes.ts';
const BENCH_SOURCE = /^bench\/src\/(?!.*\.test\.[cm]?[jt]s$)/;

const TEST_FUNCTIONS = new Set(['describe', 'it', 'test']);
// `it.only(title, fn)`: the modified function still takes the title first.
const TEST_MODIFIERS = new Set([
  'only',
  'skip',
  'todo',
  'concurrent',
  'sequential',
  'shuffle',
  'fails',
]);
// `it.each(table)(title, fn)`: the factory's own arguments are test data, not a title.
const TEST_FACTORIES = new Set(['each', 'for', 'skipIf', 'runIf']);

// A comment that instructs a tool, matched only at its start as the tools themselves do.
const DIRECTIVE =
  /^\/\/\/\s*<(?:reference|amd)[^>]*>|^(?:\/\/|\/\*+)\s*(?:@ts-(?:check|nocheck|ignore|expect-error)|biome-ignore\s+\S+|(?:v8|c8|istanbul)\s+ignore(?:\s+(?:next|start|stop|if|else|file))?|eslint-(?:disable|enable)[\w-]*|@vitest-environment\s+\S+|[@#]__PURE__)/;

const STRING_KINDS = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
]);
const CLOSERS = new Set([')', ']', '}']);

/**
 * The file's tokens without comments or whitespace. A test title and a `SHAPES` `why` each
 * become one token, so a reworded one is one difference however it is spelled.
 *
 * @param {string} text
 * @param {string} file the path relative to the root, with POSIX separators
 * @returns {Token[]}
 */
export function tokenize(text, file) {
  const kind = scriptKind(file);
  const normalized = text.replace(/\r\n?/g, '\n');
  const sourceFile = ts.createSourceFile(file, normalized, ts.ScriptTarget.Latest, true, kind);
  /** @type {ts.JSDoc[]} */
  const jsDocs = [];
  const tokenNodes = tokensOf(sourceFile, jsDocs);
  const placed = [
    ...codeTokens(sourceFile, file, tokenNodes),
    ...actingComments(sourceFile, kind, tokenNodes, jsDocs),
  ];
  const tokens = placed.sort((a, b) => a.pos - b.pos).map((entry) => entry.token);
  return tokens.filter((token, index) => {
    const next = tokens[index + 1];
    return !(token.text === ',' && next !== undefined && CLOSERS.has(next.text));
  });
}

/**
 * The code's own tokens, with each test title and `SHAPES` `why` folded into one.
 *
 * @param {ts.SourceFile} sourceFile
 * @param {string} file
 * @param {readonly ts.Node[]} tokenNodes
 * @returns {{ pos: number, token: Token }[]}
 */
function codeTokens(sourceFile, file, tokenNodes) {
  const units = unitSpans(sourceFile, file);
  const layout = layoutTokens(sourceFile);
  /** @type {Map<number, string[]>} */
  const unitTexts = new Map();
  /** @type {{ pos: number, token: Token }[]} */
  const placed = [];
  let unitIndex = 0;
  for (const node of tokenNodes) {
    const start = node.getStart(sourceFile);
    const text = node.getText(sourceFile);
    if (node.kind === ts.SyntaxKind.EndOfFileToken || text.trim() === '') continue;
    if (layout.get(start) === text) continue;
    while ((units[unitIndex]?.end ?? Number.POSITIVE_INFINITY) <= start) unitIndex += 1;
    const unit = units[unitIndex];
    if (unit !== undefined && start >= unit.start) {
      unitTexts.set(unitIndex, [...(unitTexts.get(unitIndex) ?? []), text]);
      continue;
    }
    const token = plain(ts.SyntaxKind[node.kind], text, lineOf(sourceFile, start), false);
    placed.push({ pos: start, token: { ...token, isString: STRING_KINDS.has(node.kind) } });
  }
  for (const [index, texts] of unitTexts) {
    const unit = /** @type {{ start: number, unit: 'title' | 'why' }} */ (units[index]);
    const text = texts.join(' ');
    placed.push({
      pos: unit.start,
      token: {
        key: `${unit.unit}\u0000${text}`,
        text,
        line: lineOf(sourceFile, unit.start),
        unit: unit.unit,
        isString: false,
      },
    });
  }
  return placed;
}

/**
 * Tokens the formatter adds or removes with a line break, which never change behaviour:
 * the leading operator of a union or intersection type, and parentheses around the whole
 * value of a `return` or `throw`. Keyed by position, with the text expected there.
 *
 * @param {ts.SourceFile} sourceFile
 * @returns {Map<number, string>}
 */
function layoutTokens(sourceFile) {
  /** @type {Map<number, string>} */
  const found = new Map();
  /** @param {ts.Node} node */
  const visit = (node) => {
    if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
      const start = node.getStart(sourceFile);
      const first = node.types[0];
      if (first !== undefined && start < first.getStart(sourceFile)) {
        found.set(start, sourceFile.text.charAt(start));
      }
    }
    if (
      ts.isParenthesizedExpression(node) &&
      (ts.isReturnStatement(node.parent) || ts.isThrowStatement(node.parent)) &&
      node.parent.expression === node
    ) {
      found.set(node.getStart(sourceFile), '(');
      found.set(node.end - 1, ')');
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/**
 * The parts outside the code's tokens that still act: the shebang, each tool directive,
 * and in JavaScript the types JSDoc declares.
 *
 * @param {ts.SourceFile} sourceFile
 * @param {ts.ScriptKind} kind
 * @param {readonly ts.Node[]} tokenNodes
 * @param {readonly ts.JSDoc[]} jsDocs
 * @returns {{ pos: number, token: Token }[]}
 */
function actingComments(sourceFile, kind, tokenNodes, jsDocs) {
  /** @type {{ pos: number, token: Token }[]} */
  const placed = [];
  const shebang = ts.getShebang(sourceFile.text);
  if (shebang) placed.push({ pos: 0, token: plain('shebang', shebang, 1, false) });
  const javascript = kind === ts.ScriptKind.JS || kind === ts.ScriptKind.JSX;
  for (const { pos, text } of javascript ? jsDocTypes(sourceFile, jsDocs) : []) {
    placed.push({ pos, token: plain('jsdoc-type', text, lineOf(sourceFile, pos), false) });
  }
  for (const { pos, text } of directiveComments(sourceFile, tokenNodes)) {
    placed.push({ pos, token: plain('directive', text, lineOf(sourceFile, pos), false) });
  }
  return placed;
}

/** @param {ts.SourceFile} sourceFile @param {number} pos */
function lineOf(sourceFile, pos) {
  return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
}

/**
 * Compares two versions of one file.
 *
 * @param {string} before
 * @param {string} after
 * @param {string} file the path relative to the root, with POSIX separators
 * @returns {Difference[]} empty when the change touched only comments and whitespace
 */
export function compareSources(before, after, file) {
  const a = tokenize(before, file);
  const b = tokenize(after, file);
  /** @type {Difference[]} */
  const differences = [];
  for (const hunk of diffTokens(a, b)) {
    const removed = a.slice(hunk.aStart, hunk.aEnd);
    const added = b.slice(hunk.bStart, hunk.bEnd);
    if (removed.length !== added.length) {
      differences.push({ kind: 'code', before: removed, after: added });
      continue;
    }
    removed.forEach((old, index) => {
      const replacement = /** @type {Token} */ (added[index]);
      differences.push({
        kind: classify(old, replacement, file),
        before: [old],
        after: [replacement],
      });
    });
  }
  return differences;
}

/**
 * @param {Token} before
 * @param {Token} after
 * @param {string} file
 * @returns {DifferenceKind}
 */
function classify(before, after, file) {
  if (before.unit === 'title' && after.unit === 'title') return 'test-title';
  if (before.unit === 'why' && after.unit === 'why') return 'shapes-why';
  if (
    BENCH_SOURCE.test(file) &&
    before.isString &&
    after.isString &&
    hasReference(before.text) &&
    !hasReference(after.text)
  ) {
    return 'bench-string';
  }
  return 'code';
}

/**
 * The minimal set of hunks turning `a` into `b`, by Myers' algorithm. Each hunk replaces
 * `a[aStart, aEnd)` with `b[bStart, bEnd)`.
 *
 * @param {readonly Token[]} a
 * @param {readonly Token[]} b
 * @returns {{ aStart: number, aEnd: number, bStart: number, bEnd: number }[]}
 */
export function diffTokens(a, b) {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix]?.key === b[prefix]?.key) prefix += 1;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix]?.key === b[b.length - 1 - suffix]?.key
  ) {
    suffix += 1;
  }
  const x = a.slice(prefix, a.length - suffix).map((token) => token.key);
  const y = b.slice(prefix, b.length - suffix).map((token) => token.key);
  if (x.length === 0 && y.length === 0) return [];
  return groupEdits(shortestEdit(x, y), x.length, y.length).map((hunk) => ({
    aStart: hunk.aStart + prefix,
    aEnd: hunk.aEnd + prefix,
    bStart: hunk.bStart + prefix,
    bEnd: hunk.bEnd + prefix,
  }));
}

/**
 * Groups adjacent removals and insertions into hunks.
 *
 * @param {{ removed: Set<number>, inserted: Set<number> }} edits
 * @param {number} n the length of the old sequence
 * @param {number} m the length of the new sequence
 */
function groupEdits({ removed, inserted }, n, m) {
  const isEdit = (/** @type {number} */ i, /** @type {number} */ j) =>
    (i < n && removed.has(i)) || (j < m && inserted.has(j));
  /** @type {{ aStart: number, aEnd: number, bStart: number, bEnd: number }[]} */
  const hunks = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (!isEdit(i, j)) {
      i += 1;
      j += 1;
      continue;
    }
    const aStart = i;
    const bStart = j;
    while (isEdit(i, j)) {
      if (i < n && removed.has(i)) i += 1;
      else j += 1;
    }
    hunks.push({ aStart, aEnd: i, bStart, bEnd: j });
  }
  return hunks;
}

/**
 * Which items of `x` are removed and which of `y` inserted, in a shortest edit script
 * (Myers' algorithm). Past two thousand edits the files are not a comment change, and the
 * whole middle is reported as one replacement rather than spending more memory to align it.
 *
 * @param {readonly string[]} x
 * @param {readonly string[]} y
 * @returns {{ removed: Set<number>, inserted: Set<number> }}
 */
function shortestEdit(x, y) {
  const limit = Math.min(x.length + y.length, 2000);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  /** @type {Int32Array[]} */
  const trace = [];
  let found = -1;
  for (let d = 0; d <= limit && found < 0; d += 1) {
    for (let k = -d; k <= d; k += 2) {
      const col = furthestReach(v, offset, d, k, x, y);
      v[offset + k] = col;
      if (col >= x.length && col - k >= y.length) found = d;
    }
    trace.push(v.slice());
  }
  if (found < 0) {
    return {
      removed: new Set(x.keys()),
      inserted: new Set(y.keys()),
    };
  }
  return backtrack(trace, offset, found, x.length, y.length);
}

/**
 * How far along diagonal `k` a path of `d` edits reaches: one step from the better
 * neighbouring diagonal, then as many matching items as follow.
 *
 * @param {Int32Array} v the furthest column reached on each diagonal after `d - 1` edits
 * @param {number} offset
 * @param {number} d
 * @param {number} k
 * @param {readonly string[]} x
 * @param {readonly string[]} y
 */
function furthestReach(v, offset, d, k, x, y) {
  let col = takesInsertion(v, offset, d, k) ? at(v, offset + k + 1) : at(v, offset + k - 1) + 1;
  while (col < x.length && col - k < y.length && x[col] === y[col - k]) col += 1;
  return col;
}

/**
 * Walks the trace back from the end, recording the one edit taken at each step.
 *
 * @param {readonly Int32Array[]} trace
 * @param {number} offset
 * @param {number} found the number of edits
 * @param {number} n
 * @param {number} m
 */
function backtrack(trace, offset, found, n, m) {
  /** @type {Set<number>} */
  const removed = new Set();
  /** @type {Set<number>} */
  const inserted = new Set();
  let col = n;
  let row = m;
  for (let d = found; d > 0; d -= 1) {
    const previous = /** @type {Int32Array} */ (trace[d - 1]);
    const k = col - row;
    const insertion = takesInsertion(previous, offset, d, k);
    const previousK = insertion ? k + 1 : k - 1;
    const previousCol = at(previous, offset + previousK);
    const previousRow = previousCol - previousK;
    if (insertion) inserted.add(previousRow);
    else removed.add(previousCol);
    col = previousCol;
    row = previousRow;
  }
  return { removed, inserted };
}

/**
 * Whether the path onto diagonal `k` comes down from `k + 1` (an insertion) rather than
 * across from `k - 1` (a removal).
 *
 * @param {Int32Array} v
 * @param {number} offset
 * @param {number} d
 * @param {number} k
 */
function takesInsertion(v, offset, d, k) {
  return k === -d || (k !== d && at(v, offset + k - 1) < at(v, offset + k + 1));
}

/** @param {Int32Array} array @param {number} index */
function at(array, index) {
  return array[index] ?? 0;
}

/**
 * The files changed between two revisions, or between a revision and the working tree
 * (untracked files included).
 *
 * @param {Options} options
 * @returns {ChangedFile[]}
 */
export function changedFiles({ root, base, head }) {
  const range = head === null ? [base] : [base, head];
  const listed = git(root, ['diff', '--name-status', '--no-renames', '-z', ...range, '--']);
  const fields = listed.split('\0').filter((field) => field !== '');
  /** @type {ChangedFile[]} */
  const files = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const letter = fields[i] ?? '';
    const file = fields[i + 1] ?? '';
    const status = letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified';
    files.push({ status, file });
  }
  if (head === null) {
    const status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    for (const entry of status.split('\0')) {
      if (entry.startsWith('?? ')) files.push({ status: 'added', file: entry.slice(3) });
    }
  }
  return files.sort((p, q) => (p.file < q.file ? -1 : p.file > q.file ? 1 : 0));
}

/**
 * Runs the comparison and renders the report.
 *
 * @param {Options} options
 * @returns {{ exitCode: number, output: string }}
 */
export function run(options) {
  const { root, base, head, paths } = options;
  const wanted = paths.map((p) => p.split(path.sep).join('/').replace(/\/$/, ''));
  const files = changedFiles(options).filter(
    (changed) =>
      wanted.length === 0 ||
      wanted.some((p) => changed.file === p || changed.file.startsWith(`${p}/`)),
  );
  const lines = [
    `Token diff: ${base} to ${head ?? 'the working tree'}, ${plural(files.length, 'changed file')}.`,
  ];
  /** @type {Record<DifferenceKind, number>} */
  const totals = { 'test-title': 0, 'shapes-why': 0, 'bench-string': 0, code: 0 };
  let failures = 0;
  let unchanged = 0;
  /** @type {string[]} */
  const notCompared = [];

  for (const { status, file } of files) {
    if (isTestData(file)) {
      failures += 1;
      lines.push(
        '',
        `${file}: test data ${status}. Nothing under a fixtures or tree folder may change.`,
      );
      continue;
    }
    if (!SOURCE_EXTENSION.test(file)) {
      notCompared.push(`${file} (${status})`);
      continue;
    }
    if (status !== 'modified') {
      failures += 1;
      lines.push('', `${file}: source file ${status}.`);
      continue;
    }
    const before = git(root, ['show', `${base}:${file}`]);
    const after =
      head === null
        ? readFileSync(path.join(root, file), 'utf8')
        : git(root, ['show', `${head}:${file}`]);
    const differences = compareSources(before, after, file);
    if (differences.length === 0) {
      unchanged += 1;
      continue;
    }
    lines.push('', `${file}:`);
    for (const difference of differences) {
      totals[difference.kind] += 1;
      if (difference.kind === 'code') failures += 1;
      lines.push(...render(difference));
    }
  }

  lines.push('');
  if (notCompared.length > 0) lines.push(`Not source, so not compared: ${notCompared.join(', ')}.`);
  lines.push(
    `Compared ${plural(files.length - notCompared.length, 'file')}: ${unchanged} differ only in comments and whitespace.`,
    `Allowed differences: ${plural(totals['test-title'], 'test title')}, ${plural(totals['shapes-why'], 'SHAPES why string')}, ${plural(totals['bench-string'], 'bench string')}.`,
    failures === 0
      ? 'No change outside comments and the allowed kinds.'
      : `${plural(failures, 'change')} outside comments and the allowed kinds.`,
  );
  return { exitCode: failures === 0 ? 0 : 1, output: `${lines.join('\n')}\n` };
}

/** @param {Difference} difference @returns {string[]} */
function render(difference) {
  const text = (/** @type {Token[]} */ tokens) =>
    tokens
      .map((token) => token.text)
      .join(' ')
      .replace(/\s+/g, ' ');
  const { kind, before, after } = difference;
  const label = KIND_LABELS[kind];
  const [first] = before;
  const [firstAfter] = after;
  if (first === undefined) {
    return [`  ${label}, added at line ${firstAfter?.line}:`, `    + ${text(after)}`];
  }
  if (firstAfter === undefined) {
    return [`  ${label}, removed at line ${first.line}:`, `    - ${text(before)}`];
  }
  return [
    `  ${label}, line ${first.line} to line ${firstAfter.line}:`,
    `    - ${text(before)}`,
    `    + ${text(after)}`,
  ];
}

/**
 * The spans that become a single token: each test title, and each `why` of `SHAPES`.
 *
 * @param {ts.SourceFile} sourceFile
 * @param {string} file
 * @returns {{ start: number, end: number, unit: 'title' | 'why' }[]}
 */
function unitSpans(sourceFile, file) {
  /** @type {{ start: number, end: number, unit: 'title' | 'why' }[]} */
  const spans = [];
  /** @param {ts.Node} node */
  const visit = (node) => {
    if (ts.isCallExpression(node) && isTestCall(node.expression)) {
      const title = node.arguments[0];
      if (title !== undefined) {
        spans.push({ start: title.getStart(sourceFile), end: title.end, unit: 'title' });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (file === SHAPES_FILE) {
    for (const initializer of shapesWhyInitializers(sourceFile)) {
      spans.push({ start: initializer.getStart(sourceFile), end: initializer.end, unit: 'why' });
    }
  }
  spans.sort((p, q) => p.start - q.start);
  // A span inside another is already part of it.
  return spans.filter(
    (span, index) => !spans.slice(0, index).some((outer) => outer.end >= span.end),
  );
}

/**
 * The initializer of every `why` property in the exported `SHAPES` array literal.
 *
 * @param {ts.SourceFile} sourceFile
 * @returns {ts.Expression[]}
 */
function shapesWhyInitializers(sourceFile) {
  const table = exportedInitializer(sourceFile, 'SHAPES');
  if (table === undefined || !ts.isArrayLiteralExpression(table)) return [];
  return table.elements.flatMap((element) =>
    ts.isObjectLiteralExpression(element)
      ? element.properties.flatMap((property) =>
          ts.isPropertyAssignment(property) &&
          ts.isIdentifier(property.name) &&
          property.name.text === 'why'
            ? [property.initializer]
            : [],
        )
      : [],
  );
}

/**
 * The value an exported `const` is initialised with, without `as` or `satisfies`.
 *
 * @param {ts.SourceFile} sourceFile
 * @param {string} name
 * @returns {ts.Expression | undefined}
 */
function exportedInitializer(sourceFile, name) {
  const declaration = sourceFile.statements
    .filter(ts.isVariableStatement)
    .filter((statement) => statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name);
  let value = declaration?.initializer;
  while (value && (ts.isSatisfiesExpression(value) || ts.isAsExpression(value))) {
    value = value.expression;
  }
  return value;
}

/**
 * Whether a call's callee takes a test title first: `it`, `describe.skip`, or the function
 * a factory returns, as in `it.each(table)` or `it.skipIf(condition)`.
 *
 * @param {ts.Expression} callee
 */
function isTestCall(callee) {
  if (isTestFunction(callee)) return true;
  if (ts.isCallExpression(callee) && ts.isPropertyAccessExpression(callee.expression)) {
    return (
      TEST_FACTORIES.has(callee.expression.name.text) &&
      isTestFunction(callee.expression.expression)
    );
  }
  if (ts.isTaggedTemplateExpression(callee) && ts.isPropertyAccessExpression(callee.tag)) {
    return TEST_FACTORIES.has(callee.tag.name.text) && isTestFunction(callee.tag.expression);
  }
  return false;
}

/** @param {ts.Expression} expression */
function isTestFunction(expression) {
  if (ts.isIdentifier(expression)) return TEST_FUNCTIONS.has(expression.text);
  if (ts.isPropertyAccessExpression(expression) && TEST_MODIFIERS.has(expression.name.text)) {
    return isTestFunction(expression.expression);
  }
  return false;
}

/**
 * Every token of a file in source order, the end-of-file token included, found without
 * recursion so deep nesting cannot overflow the stack. JSDoc nodes are set aside rather
 * than read as tokens: their children are the comment's contents.
 *
 * @param {ts.SourceFile} sourceFile
 * @param {ts.JSDoc[]} [jsDocs] receives each JSDoc comment
 * @returns {ts.Node[]}
 */
function tokensOf(sourceFile, jsDocs = []) {
  /** @type {ts.Node[]} */
  const tokens = [];
  /** @type {ts.Node[]} */
  const stack = [sourceFile];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    const kind = node.kind;
    if (kind >= ts.SyntaxKind.FirstJSDocNode && kind <= ts.SyntaxKind.LastJSDocNode) {
      if (ts.isJSDoc(node)) jsDocs.push(node);
      continue;
    }
    if (kind > ts.SyntaxKind.LastToken) {
      // A copy: `getChildren` returns the parser's cached array.
      stack.push(...[...node.getChildren(sourceFile)].reverse());
    } else if (node.pos !== node.end || kind === ts.SyntaxKind.EndOfFileToken) {
      tokens.push(node);
    }
  }
  return tokens;
}

/**
 * The types a JavaScript file's JSDoc declares, one entry per tag. The type checker reads
 * them, so a changed one is a change of code; the prose beside them is still comment.
 *
 * @param {ts.SourceFile} sourceFile
 * @param {readonly ts.JSDoc[]} jsDocs
 * @returns {{ pos: number, text: string }[]}
 */
function jsDocTypes(sourceFile, jsDocs) {
  return jsDocs.flatMap((doc) =>
    (doc.tags ?? []).flatMap((tag) => {
      const typed = /** @type {{ typeExpression?: ts.Node, name?: ts.Node }} */ (tag);
      const parts = [
        typed.typeExpression?.getText(sourceFile),
        typed.name?.getText(sourceFile),
        ...(ts.isJSDocTemplateTag(tag) ? tag.typeParameters.map((p) => p.getText(sourceFile)) : []),
      ].filter((part) => part !== undefined);
      if (parts.length === 0) return [];
      return [{ pos: tag.pos, text: [`@${tag.tagName.text}`, ...parts].join(' ') }];
    }),
  );
}

/**
 * The comments that instruct a tool, each reduced to its instruction so the prose after it
 * can still be reworded.
 *
 * @param {ts.SourceFile} sourceFile
 * @param {readonly ts.Node[]} tokens every token, the end-of-file token included
 * @returns {{ pos: number, text: string }[]}
 */
function directiveComments(sourceFile, tokens) {
  const text = sourceFile.text;
  const shebangLength = (ts.getShebang(text) ?? '').length;
  /** @type {Map<number, string>} */
  const found = new Map();
  /** @type {(pos: number, end: number) => void} */
  const collect = (pos, end) => {
    const match = DIRECTIVE.exec(text.slice(pos, end));
    if (match && !found.has(pos)) found.set(pos, match[0].replace(/\s+/g, ' '));
  };
  for (const token of tokens) {
    ts.forEachLeadingCommentRange(text, token.pos === 0 ? shebangLength : token.pos, collect);
    ts.forEachTrailingCommentRange(text, token.end, collect);
  }
  return [...found.entries()].map(([pos, directive]) => ({ pos, text: directive }));
}

/**
 * @param {string} kind
 * @param {string} text
 * @param {number} line
 * @param {boolean} isString
 * @returns {Token}
 */
function plain(kind, text, line, isString) {
  return { key: `${kind}\u0000${text}`, text, line, unit: null, isString };
}

/** @param {string} file */
function scriptKind(file) {
  if (/\.[cm]?jsx?$/.test(file)) return file.endsWith('x') ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
  return file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

/** A path under a folder that holds test data, which no comment sweep may touch. @param {string} file */
function isTestData(file) {
  const folders = file.split('/').slice(0, -1);
  return file.startsWith('coverage-tree/tree/') || folders.includes('fixtures');
}

/** @param {string} text */
function hasReference(text) {
  return (text.replace(URL_PATTERN, ' ').match(INTERNAL_REFERENCE)?.length ?? 0) > 0;
}

/** @param {string} root @param {readonly string[]} args */
function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/** @param {number} n @param {string} noun */
function plural(n, noun) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * Without `--head` the working tree is compared with `--base`, which defaults to `HEAD`.
 *
 * @param {readonly string[]} argv the arguments after the script's path
 * @returns {Options | string} the options, or a usage error
 */
export function parseArgs(argv) {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let base = 'HEAD';
  /** @type {string | null} */
  let head = null;
  /** @type {string[]} */
  const paths = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--base' || arg === '--head' || arg === '--root') {
      const value = argv[i + 1];
      if (value === undefined) return `${arg} needs a value`;
      if (arg === '--base') base = value;
      else if (arg === '--head') head = value;
      else root = path.resolve(value);
      i += 1;
    } else if (arg.startsWith('--')) {
      return `unknown argument: ${arg}`;
    } else {
      paths.push(arg);
    }
  }
  if (!existsSync(root)) return `no such directory: ${root}`;
  return { root, base, head, paths };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  if (typeof options === 'string') {
    process.stderr.write(`token-diff: ${options}\n`);
    process.exit(2);
  }
  const result = run(options);
  (result.exitCode === 0 ? process.stdout : process.stderr).write(result.output);
  process.exit(result.exitCode);
}
