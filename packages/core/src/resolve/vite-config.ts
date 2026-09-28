/**
 * Read a Vite config's `resolve.alias` without running it.
 *
 * A config is a module, so it is parsed as one, and each alias value is evaluated over a
 * closed list of expressions whose result depends only on where the config file sits:
 * string and template literals, `+`, `__dirname`, `__filename`, `import.meta.url`,
 * `import.meta.dirname`, `import.meta.filename`, `path.resolve`, `path.join`, `path.dirname`,
 * `fileURLToPath` and `new URL(s, base)`, and a top-level `const` holding one of them. A name
 * bound any other way is off the list. Anything off the list is reported with its line and
 * never evaluated. See "Aliases are read, never executed" in ARCHITECTURE.md.
 */

import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from '@babel/parser';
import type * as t from '@babel/types';

/** One alias Vite would apply: `find`, as the whole path or before a `/`, becomes `target`. */
export interface ViteAliasEntry {
  readonly find: string;
  /** Absolute path. */
  readonly target: string;
  readonly line: number;
}

/** An alias, or the config around it, that Upfly found and could not read. */
export interface ViteAliasUnread {
  readonly line: number | null;
  readonly reason: string;
}

export interface ViteAliases {
  readonly entries: readonly ViteAliasEntry[];
  readonly unread: readonly ViteAliasUnread[];
}

type Imported =
  | 'path'
  | 'path.resolve'
  | 'path.join'
  | 'path.dirname'
  | 'url'
  | 'url.fileURLToPath'
  | 'url.URL'
  | 'vite'
  | 'vite.defineConfig';

type Module = 'path' | 'url' | 'vite';

type Property = t.ObjectExpression['properties'][number];

interface Context {
  readonly configPath: string;
  /** Top-level `const` initialisers, by name. */
  readonly consts: Map<string, t.Expression>;
  /** What each imported or required name stands for. */
  readonly imports: Map<string, Imported>;
  /** How many times each name is bound anywhere in the file. */
  readonly bindings: Map<string, number>;
}

interface Sink {
  readonly entries: ViteAliasEntry[];
  readonly unread: ViteAliasUnread[];
}

/** What an expression on the list evaluates to, and whether the config's location made it. */
type Value =
  | { readonly kind: 'string'; readonly text: string; readonly located: boolean }
  | { readonly kind: 'url'; readonly href: string };

/** Thrown where an expression is off the list; caught once per alias, or for the config. */
class OffTheList {
  constructor(
    readonly line: number | null,
    readonly why: string,
  ) {}
}

const MODULES: Readonly<Record<string, Module>> = {
  path: 'path',
  'node:path': 'path',
  url: 'url',
  'node:url': 'url',
  vite: 'vite',
  'vitest/config': 'vite',
};
const MEMBERS: Readonly<Record<Module, Readonly<Record<string, Imported>>>> = {
  path: { resolve: 'path.resolve', join: 'path.join', dirname: 'path.dirname' },
  url: { fileURLToPath: 'url.fileURLToPath', URL: 'url.URL' },
  vite: { defineConfig: 'vite.defineConfig' },
};
const DEPTH = 32;
const RUNS_CODE = 'is built by code Upfly does not run';

/**
 * The aliases a Vite config declares, and what in it could not be read.
 *
 * @param text The config's source.
 * @param configPath The config's absolute path: `__dirname` and `import.meta.url` are its.
 */
export function readViteAliases(text: string, configPath: string): ViteAliases {
  let program: t.Program;
  try {
    program = parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, {
      sourceType: 'unambiguous',
      plugins: /\.[cm]?ts$/.test(configPath) ? ['typescript'] : [],
    }).program;
  } catch {
    return {
      entries: [],
      unread: [{ line: null, reason: 'could not be parsed, so its aliases were not read' }],
    };
  }

  const context: Context = {
    configPath,
    consts: new Map(),
    imports: new Map(),
    bindings: countBindings(program),
  };
  for (const statement of program.body) {
    if (statement.type === 'ImportDeclaration') collectImport(statement, context);
    else if (statement.type === 'VariableDeclaration' && statement.kind === 'const') {
      collectConst(statement, context);
    }
  }

  const sink: Sink = { entries: [], unread: [] };
  try {
    const config = configObject(program, context);
    const section = config === null ? null : objectAt(config, 'resolve', context);
    const alias = section === null ? null : valueAt(section, 'alias', context);
    if (config !== null && alias !== null) readAlias(alias, rootOf(config, context), context, sink);
  } catch (error) {
    if (!(error instanceof OffTheList)) throw error;
    sink.unread.push({ line: error.line, reason: `${error.why}, so its aliases were not read` });
  }
  return sink;
}

// ---------------------------------------------------------------------------
// resolve.alias
// ---------------------------------------------------------------------------

function readAlias(alias: t.Expression, root: string, context: Context, sink: Sink): void {
  if (alias.type === 'ObjectExpression') {
    for (const property of inKeyOrder(alias.properties)) {
      readObjectEntry(property, root, context, sink);
    }
    return;
  }
  if (alias.type === 'ArrayExpression') {
    for (const element of alias.elements) readArrayEntry(element, root, context, sink);
    return;
  }
  const line = lineOf(alias);
  throw new OffTheList(line, `resolve.alias at line ${line} ${RUNS_CODE}`);
}

/**
 * An object literal's properties in the order JavaScript enumerates the object, which is the
 * order Vite tries its aliases in: keys that are array indices first, ascending, then the
 * rest as written, a repeated key keeping its first place and its last value. A property with
 * no static key stays where it is written.
 */
function inKeyOrder(properties: readonly Property[]): Property[] {
  const staticKey = (property: Property) =>
    property.type === 'ObjectProperty' ? keyOf(property) : null;
  const last = new Map<string, Property>();
  for (const property of properties) {
    const key = staticKey(property);
    if (key !== null) last.set(key, property);
  }

  const indices: { readonly index: number; readonly property: Property }[] = [];
  const rest: Property[] = [];
  for (const property of properties) {
    const key = staticKey(property);
    if (key === null) {
      rest.push(property);
      continue;
    }
    const kept = last.get(key);
    // Taken already, at the key's first place.
    if (kept === undefined) continue;
    last.delete(key);
    if (isArrayIndex(key)) indices.push({ index: Number(key), property: kept });
    else rest.push(kept);
  }
  indices.sort((a, b) => a.index - b.index);
  return [...indices.map(({ property }) => property), ...rest];
}

/** A key JavaScript reads as an array index: a canonical integer below 2^32 - 1. */
function isArrayIndex(key: string): boolean {
  return /^(0|[1-9]\d*)$/.test(key) && Number(key) < 2 ** 32 - 1;
}

function readObjectEntry(
  property: t.ObjectExpression['properties'][number],
  root: string,
  context: Context,
  sink: Sink,
): void {
  const line = lineOf(property);
  if (property.type !== 'ObjectProperty') {
    sink.unread.push({
      line,
      reason: `resolve.alias at line ${line} holds a spread or a method, so it was not read`,
    });
    return;
  }
  readOne(keyOf(property), property.value, line, root, context, sink);
}

function readArrayEntry(
  element: t.ArrayExpression['elements'][number],
  root: string,
  context: Context,
  sink: Sink,
): void {
  const line = lineOf(element);
  const problem = arrayEntryProblem(element);
  if (problem !== null) {
    sink.unread.push({ line, reason: `the alias at line ${line} ${problem}, so it was not read` });
    return;
  }
  const entry = element as t.ObjectExpression;
  const find = propertyValue(entry, 'find') as t.StringLiteral;
  readOne(
    find.value,
    propertyValue(entry, 'replacement') as t.Expression,
    line,
    root,
    context,
    sink,
  );
}

/** Why an array entry cannot be read, or `null` when its `find` and `replacement` can be. */
function arrayEntryProblem(element: t.ArrayExpression['elements'][number]): string | null {
  if (element?.type !== 'ObjectExpression') return 'is not an object';
  if (element.properties.some((property) => keyOfAny(property) === 'customResolver')) {
    return 'has a customResolver, which Upfly does not run';
  }
  if (propertyValue(element, 'find')?.type !== 'StringLiteral') {
    return 'finds by a pattern, not a string';
  }
  return propertyValue(element, 'replacement') === null ? 'has no replacement' : null;
}

function readOne(
  find: string | null,
  value: t.Node,
  line: number | null,
  root: string,
  context: Context,
  sink: Sink,
): void {
  const named = find === null ? 'an alias' : `the alias "${find}"`;
  try {
    if (find === null) throw new OffTheList(line, 'has a key Upfly does not run code to read');
    const evaluated = evaluate(value, context, 0);
    // Vite drops a trailing `/` from the key and the replacement it was given, only when both
    // have one, before the replacement is read as a path.
    const trailing =
      find.endsWith('/') && evaluated.kind === 'string' && evaluated.text.endsWith('/');
    const replacement =
      trailing && evaluated.kind === 'string'
        ? { ...evaluated, text: evaluated.text.slice(0, -1) }
        : evaluated;
    sink.entries.push({
      find: trailing ? find.slice(0, -1) : find,
      target: targetOf(replacement, root, line),
      line: line ?? 0,
    });
  } catch (error) {
    if (!(error instanceof OffTheList)) throw error;
    const where = error.line === null ? '' : ` at line ${error.line}`;
    sink.unread.push({
      line: error.line,
      reason: `${named}${where} ${error.why}, so it was not read`,
    });
  }
}

/**
 * Where a value points. A path computed from the config's location is taken as it is; a
 * string starting with `/` is read from the Vite root; a relative or bare string is not read,
 * since Vite resolves the one from each importing file and the other names a package.
 */
function targetOf(value: Value, root: string, line: number | null): string {
  if (value.kind === 'url') throw new OffTheList(line, 'is a URL, not a path');
  const { text } = value;
  if (value.located) {
    if (isAbsolute(text)) return text;
    throw new OffTheList(line, 'is built from the config location into a relative path');
  }
  if (text.startsWith('/')) {
    return text.startsWith(toSlashes(root)) || text.startsWith(root) ? text : join(root, text);
  }
  if (isAbsolute(text)) return text;
  if (text.startsWith('.'))
    throw new OffTheList(line, 'names a folder relative to each importing file');
  throw new OffTheList(line, 'maps to a package');
}

// ---------------------------------------------------------------------------
// the closed list
// ---------------------------------------------------------------------------

function evaluate(node: t.Node, context: Context, depth: number): Value {
  const line = lineOf(node);
  if (depth > DEPTH) throw new OffTheList(line, RUNS_CODE);

  let value: Value | null = null;
  switch (node.type) {
    case 'StringLiteral':
      value = { kind: 'string', text: node.value, located: false };
      break;
    case 'TemplateLiteral':
      value = templateValue(node, context, depth);
      break;
    case 'BinaryExpression':
      value = node.operator === '+' ? joinedValue(node, context, depth) : null;
      break;
    case 'Identifier':
      value = identifierValue(node, context, depth);
      break;
    case 'MemberExpression':
      value = importMetaValue(node, context);
      break;
    case 'CallExpression':
      value = callValue(node, context, depth);
      break;
    case 'NewExpression':
      value = urlValue(node, context, depth);
      break;
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'TSNonNullExpression':
    case 'ParenthesizedExpression':
      value = evaluate(node.expression, context, depth + 1);
      break;
    default:
      break;
  }
  if (value === null) throw new OffTheList(line, RUNS_CODE);
  return value;
}

function templateValue(node: t.TemplateLiteral, context: Context, depth: number): Value {
  let text = '';
  let located = false;
  node.quasis.forEach((quasi, index) => {
    text += quasi.value.cooked ?? quasi.value.raw;
    const expression = node.expressions[index];
    if (expression === undefined) return;
    const part = asText(evaluate(expression, context, depth + 1));
    text += part.text;
    located ||= part.located;
  });
  return { kind: 'string', text, located };
}

function joinedValue(node: t.BinaryExpression, context: Context, depth: number): Value {
  const left = asText(evaluate(node.left, context, depth + 1));
  const right = asText(evaluate(node.right, context, depth + 1));
  return { kind: 'string', text: left.text + right.text, located: left.located || right.located };
}

function identifierValue(node: t.Identifier, context: Context, depth: number): Value | null {
  const count = context.bindings.get(node.name) ?? 0;
  if (count === 0 && node.name === '__dirname') {
    return { kind: 'string', text: dirname(context.configPath), located: true };
  }
  if (count === 0 && node.name === '__filename') {
    return { kind: 'string', text: context.configPath, located: true };
  }
  const init = count === 1 ? context.consts.get(node.name) : undefined;
  return init === undefined ? null : evaluate(init, context, depth + 1);
}

function importMetaValue(node: t.MemberExpression, context: Context): Value | null {
  if (node.object.type !== 'MetaProperty' || node.object.meta.name !== 'import') return null;
  if (node.computed || node.property.type !== 'Identifier') return null;
  switch (node.property.name) {
    case 'url':
      return { kind: 'url', href: pathToFileURL(context.configPath).href };
    case 'dirname':
      return { kind: 'string', text: dirname(context.configPath), located: true };
    case 'filename':
      return { kind: 'string', text: context.configPath, located: true };
    default:
      return null;
  }
}

function urlValue(node: t.NewExpression, context: Context, depth: number): Value | null {
  if (!isUrlConstructor(node.callee, context)) return null;
  const [input, base] = arguments_(node, context, depth);
  if (input === undefined) return null;
  const from = base === undefined ? undefined : base.kind === 'url' ? base.href : base.text;
  try {
    return { kind: 'url', href: new URL(asText(input).text, from).href };
  } catch {
    throw new OffTheList(lineOf(node), 'is not a URL Node can read');
  }
}

function callValue(node: t.CallExpression, context: Context, depth: number): Value | null {
  const target = calleeOf(node.callee, context);
  if (target === 'process.cwd')
    throw new OffTheList(lineOf(node), 'depends on the folder Vite runs in');
  if (target === 'path.resolve' || target === 'path.join' || target === 'path.dirname') {
    return pathValue(target, arguments_(node, context, depth).map(asText), lineOf(node));
  }
  if (target !== 'url.fileURLToPath') return null;
  const [value] = arguments_(node, context, depth);
  if (value === undefined) return null;
  try {
    const path = fileURLToPath(value.kind === 'url' ? value.href : value.text);
    return { kind: 'string', text: path, located: value.kind === 'url' || value.located };
  } catch {
    throw new OffTheList(lineOf(node), 'is not a file URL');
  }
}

function pathValue(
  target: 'path.resolve' | 'path.join' | 'path.dirname',
  parts: readonly { text: string; located: boolean }[],
  line: number | null,
): Value {
  const located = parts.some((part) => part.located);
  const texts = parts.map((part) => part.text);
  if (target === 'path.dirname') {
    const [first] = texts;
    if (first === undefined) throw new OffTheList(line, RUNS_CODE);
    return { kind: 'string', text: dirname(first), located };
  }
  // Without an absolute part, `path.resolve` starts from the folder Vite runs in.
  if (target === 'path.resolve' && !texts.some((text) => isAbsolute(text))) {
    throw new OffTheList(line, 'depends on the folder Vite runs in');
  }
  return {
    kind: 'string',
    text: target === 'path.resolve' ? resolve(...texts) : join(...texts),
    located,
  };
}

function arguments_(
  node: t.CallExpression | t.NewExpression,
  context: Context,
  depth: number,
): Value[] {
  return node.arguments.map((argument) => {
    if (argument.type === 'SpreadElement' || argument.type === 'ArgumentPlaceholder') {
      throw new OffTheList(lineOf(argument), RUNS_CODE);
    }
    return evaluate(argument, context, depth + 1);
  });
}

/** A URL joined to text is still a URL string: reading it as a path is `fileURLToPath`'s job. */
function asText(value: Value): { text: string; located: boolean } {
  return value.kind === 'string' ? value : { text: value.href, located: true };
}

/** What a callee stands for, when it is on the list. */
function calleeOf(callee: t.Node, context: Context): Imported | 'process.cwd' | null {
  if (callee.type === 'Identifier') {
    return boundOnce(callee.name, context) ? (context.imports.get(callee.name) ?? null) : null;
  }
  if (callee.type !== 'MemberExpression' || callee.computed) return null;
  if (callee.object.type !== 'Identifier' || callee.property.type !== 'Identifier') return null;
  const object = callee.object.name;
  const member = callee.property.name;
  if (object === 'process' && member === 'cwd') {
    return (context.bindings.get('process') ?? 0) === 0 ? 'process.cwd' : null;
  }
  const module = boundOnce(object, context) ? context.imports.get(object) : undefined;
  if (module !== 'path' && module !== 'url' && module !== 'vite') return null;
  return MEMBERS[module][member] ?? null;
}

function isUrlConstructor(callee: t.Node, context: Context): boolean {
  if (callee.type !== 'Identifier' || callee.name !== 'URL') return false;
  const count = context.bindings.get('URL') ?? 0;
  return count === 0 || (count === 1 && context.imports.get('URL') === 'url.URL');
}

function boundOnce(name: string, context: Context): boolean {
  return (context.bindings.get(name) ?? 0) === 1;
}

// ---------------------------------------------------------------------------
// the config object
// ---------------------------------------------------------------------------

function configObject(program: t.Program, context: Context): t.ObjectExpression | null {
  for (const statement of program.body) {
    if (statement.type === 'ExportDefaultDeclaration') {
      return unwrapConfig(statement.declaration, context, 0);
    }
    if (
      statement.type === 'ExpressionStatement' &&
      statement.expression.type === 'AssignmentExpression' &&
      isModuleExports(statement.expression.left)
    ) {
      return unwrapConfig(statement.expression.right, context, 0);
    }
  }
  return null;
}

/**
 * The object a config expression stands for: through `satisfies`, `as`, `defineConfig(...)`,
 * a top-level `const`, and a function whose body is an object or whose one `return` sits at
 * the top of its body, as Vite calls it and awaits what it returns.
 */
function unwrapConfig(node: t.Node, context: Context, depth: number): t.ObjectExpression {
  const line = lineOf(node);
  const inner = depth > DEPTH ? null : innerConfig(node, context);
  if (inner === null) throw new OffTheList(line, `the config at line ${line} ${RUNS_CODE}`);
  return inner.type === 'ObjectExpression' ? inner : unwrapConfig(inner, context, depth + 1);
}

/** One step inward from a config expression, or `null` when the step is off the list. */
function innerConfig(node: t.Node, context: Context): t.Node | null {
  switch (node.type) {
    case 'ObjectExpression':
      return node;
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'ParenthesizedExpression':
      return node.expression;
    case 'Identifier':
      return boundOnce(node.name, context) ? (context.consts.get(node.name) ?? null) : null;
    case 'CallExpression': {
      const [argument] = node.arguments;
      const defined = calleeOf(node.callee, context) === 'vite.defineConfig';
      return defined && argument !== undefined && argument.type !== 'SpreadElement'
        ? argument
        : null;
    }
    case 'ArrowFunctionExpression':
    case 'FunctionExpression':
    case 'FunctionDeclaration':
      return node.body.type === 'BlockStatement' ? onlyReturn(node.body) : node.body;
    default:
      return null;
  }
}

function onlyReturn(body: t.BlockStatement): t.Node | null {
  const returns = body.body.filter((statement) => statement.type === 'ReturnStatement');
  const [only] = returns;
  return returns.length === 1 && only?.type === 'ReturnStatement' ? (only.argument ?? null) : null;
}

/** Vite's `root` when the config states it readably, else the config's own folder. */
function rootOf(config: t.ObjectExpression, context: Context): string {
  const folder = dirname(context.configPath);
  const root = valueAt(config, 'root', context);
  if (root === null) return folder;
  const value = evaluate(root, context, 0);
  if (value.kind !== 'string') throw new OffTheList(lineOf(root), 'root is a URL, not a path');
  return resolve(folder, value.text);
}

function objectAt(
  object: t.ObjectExpression,
  name: string,
  context: Context,
): t.ObjectExpression | null {
  const value = valueAt(object, name, context);
  if (value === null || value.type === 'ObjectExpression') return value;
  const line = lineOf(value);
  throw new OffTheList(line, `${name} at line ${line} ${RUNS_CODE}`);
}

/**
 * The value of a plain key, or `null` when the object does not set it. A spread after the
 * key could replace it, and a computed key could be it, so both are off the list.
 */
function valueAt(object: t.ObjectExpression, name: string, context: Context): t.Expression | null {
  let found: t.Expression | null = null;
  for (const property of object.properties) {
    const line = lineOf(property);
    if (property.type === 'SpreadElement' && found !== null) {
      throw new OffTheList(line, `a spread at line ${line} may replace ${name}`);
    }
    if (
      property.type !== 'SpreadElement' &&
      property.computed &&
      property.key.type !== 'StringLiteral'
    ) {
      throw new OffTheList(line, `a computed key at line ${line} may be ${name}`);
    }
    if (property.type === 'SpreadElement' || keyOfAny(property) !== name) continue;
    if (property.type !== 'ObjectProperty')
      throw new OffTheList(line, `${name} at line ${line} ${RUNS_CODE}`);
    found = followConst(property.value as t.Expression, context);
  }
  return found;
}

function followConst(node: t.Expression, context: Context): t.Expression {
  if (node.type !== 'Identifier' || !boundOnce(node.name, context)) return node;
  const init = context.consts.get(node.name);
  return init === undefined ? node : followConst(init, context);
}

function propertyValue(object: t.ObjectExpression, name: string): t.Node | null {
  for (const property of object.properties) {
    if (property.type === 'ObjectProperty' && keyOf(property) === name) return property.value;
  }
  return null;
}

function keyOf(property: t.ObjectProperty): string | null {
  if (property.key.type === 'StringLiteral') return property.key.value;
  if (property.key.type === 'Identifier' && !property.computed) return property.key.name;
  return null;
}

function keyOfAny(property: t.ObjectExpression['properties'][number]): string | null {
  if (property.type === 'SpreadElement') return null;
  if (property.type === 'ObjectProperty') return keyOf(property);
  return property.key.type === 'Identifier' && !property.computed ? property.key.name : null;
}

function isModuleExports(node: t.Node): boolean {
  return (
    node.type === 'MemberExpression' &&
    !node.computed &&
    node.object.type === 'Identifier' &&
    node.object.name === 'module' &&
    node.property.type === 'Identifier' &&
    node.property.name === 'exports'
  );
}

function lineOf(node: t.Node | null | undefined): number | null {
  return node?.loc?.start.line ?? null;
}

function toSlashes(path: string): string {
  return path.split('\\').join('/');
}

// ---------------------------------------------------------------------------
// bindings
// ---------------------------------------------------------------------------

function collectImport(statement: t.ImportDeclaration, context: Context): void {
  const module = MODULES[statement.source.value];
  if (module === undefined) return;
  for (const specifier of statement.specifiers) {
    if (specifier.type !== 'ImportSpecifier') {
      context.imports.set(specifier.local.name, module);
      continue;
    }
    const imported = specifier.imported;
    const member = MEMBERS[module][imported.type === 'Identifier' ? imported.name : imported.value];
    if (member !== undefined) context.imports.set(specifier.local.name, member);
  }
}

/** A top-level `const`: a value to follow, or a `require()` of a module on the list. */
function collectConst(statement: t.VariableDeclaration, context: Context): void {
  for (const { id, init } of statement.declarations) {
    if (init === null || init === undefined) continue;
    const required = requiredModule(init);
    if (id.type === 'Identifier') {
      if (required === null) context.consts.set(id.name, init);
      else context.imports.set(id.name, required);
      continue;
    }
    if (id.type !== 'ObjectPattern' || required === null) continue;
    for (const property of id.properties) {
      if (property.type !== 'ObjectProperty' || property.value.type !== 'Identifier') continue;
      const member = MEMBERS[required][keyOf(property) ?? ''];
      if (member !== undefined) context.imports.set(property.value.name, member);
    }
  }
}

function requiredModule(node: t.Expression): Module | null {
  if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier') return null;
  const [argument] = node.arguments;
  if (node.callee.name !== 'require' || argument?.type !== 'StringLiteral') return null;
  return MODULES[argument.value] ?? null;
}

/** How many times each name is bound anywhere: a name bound twice is never trusted. */
function countBindings(program: t.Program): Map<string, number> {
  const counts = new Map<string, number>();
  const bind = (name: string) => counts.set(name, (counts.get(name) ?? 0) + 1);
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof (node as { type?: unknown }).type !== 'string') return;
    bindDeclared(node as t.Node, bind);
    for (const [key, value] of Object.entries(node)) {
      if (key !== 'loc' && key !== 'extra' && !key.endsWith('Comments')) visit(value);
    }
  };
  visit(program);
  return counts;
}

/** Bind the names a node declares: variables, functions, classes, parameters, imports. */
function bindDeclared(node: t.Node, bind: (name: string) => void): void {
  switch (node.type) {
    case 'VariableDeclarator':
      bindPattern(node.id, bind);
      return;
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
    case 'ObjectMethod':
    case 'ClassMethod':
      if ('id' in node && node.id) bind(node.id.name);
      for (const parameter of node.params) bindPattern(parameter, bind);
      return;
    case 'ClassDeclaration':
    case 'ClassExpression':
      if (node.id) bind(node.id.name);
      return;
    case 'CatchClause':
      if (node.param) bindPattern(node.param, bind);
      return;
    case 'ImportSpecifier':
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
      bind(node.local.name);
      return;
    default:
      return;
  }
}

function bindPattern(node: t.Node | null, bind: (name: string) => void): void {
  switch (node?.type) {
    case 'Identifier':
      bind(node.name);
      return;
    case 'ObjectPattern':
      for (const property of node.properties) {
        bindPattern(property.type === 'RestElement' ? property.argument : property.value, bind);
      }
      return;
    case 'ArrayPattern':
      for (const element of node.elements) bindPattern(element, bind);
      return;
    case 'AssignmentPattern':
      bindPattern(node.left, bind);
      return;
    case 'RestElement':
      bindPattern(node.argument, bind);
      return;
    case 'TSParameterProperty':
      bindPattern(node.parameter, bind);
      return;
    default:
      return;
  }
}
