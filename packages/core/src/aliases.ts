/**
 * Read the path aliases a project declares, so `@/assets/logo.png` can resolve.
 *
 * Aliases come from tsconfig and jsconfig `paths`, following `extends`, and from a Vite
 * config's `resolve.alias`. A config is read statically or not at all: an alias the static
 * read cannot see is reported as unreadable, never evaluated, because evaluating it would run
 * code from a repository the user did not write. See "Aliases are read, never executed" in
 * ARCHITECTURE.md.
 *
 * `tsconfig.json` is JSONC, so it is parsed with `@babel/parser` as an object literal rather
 * than by stripping comments with a regex. Values are read off the AST, never rebuilt into an
 * object, so a `__proto__` key is an ordinary property.
 */

import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { parseExpression } from '@babel/parser';
import type * as t from '@babel/types';
import { compareStrings, relativePath, toPosix } from './paths.js';
import type { ReadFilePort } from './scan.js';

/** One alias mapping, anchored at an absolute directory. */
export interface AliasRule {
  /**
   * The literal prefix a reference must start with.
   *
   * `'@/*'` in a tsconfig becomes `'@/'`; an exact mapping like `'react'` keeps its
   * whole spelling and sets `wildcard: false`.
   */
  readonly prefix: string;
  /** Absolute directories (or files, for an exact rule) the prefix expands to, in order. */
  readonly targets: readonly string[];
  /**
   * Whether the rule matches a prefix rather than the whole path: a tsconfig key ending in
   * `*`, or any Vite key.
   */
  readonly wildcard: boolean;
  /** Directory the config governs: only references from inside it may use this rule. */
  readonly scope: string;
  /** POSIX-relative config file this came from, so the report can cite it. */
  readonly source: string;
}

/** A config or alias that was found but could not be read, kept so the report can say why. */
export interface AliasSkip {
  /** POSIX-relative config file. */
  readonly what: string;
  readonly reason: string;
}

export interface AliasMap {
  /** Longest prefix first, so `@/app/(create)/*` beats `@/*` on the same path. */
  readonly rules: readonly AliasRule[];
  readonly skipped: readonly AliasSkip[];
}

export interface LoadAliasesOptions {
  /** Absolute project root. */
  readonly root: string;
  /** Every file `discover` found, claimed or not, so there is no second walk. */
  readonly files: readonly { readonly path: string; readonly relative: string }[];
  readonly readFile: ReadFilePort;
  /** Whether a path exists, for `extends` targets. Same port shape as the resolver's. */
  readonly exists: (path: string) => boolean;
}

const TS_CONFIG = /^(tsconfig(\.[^/]+)?\.json|jsconfig\.json)$/;
const VITE_CONFIG = /^vite\.config\.(js|cjs|mjs|ts|cts|mts)$/;

/**
 * Read every alias the project declares. An alias that cannot be read statically is
 * returned in `skipped` with a reason, never evaluated.
 *
 * The filesystem is reached only through `readFile` and `exists`, so this can be tested
 * against an in-memory map.
 */
export async function loadAliases(options: LoadAliasesOptions): Promise<AliasMap> {
  const rules: AliasRule[] = [];
  const skipped: AliasSkip[] = [];

  for (const file of options.files) {
    const name = file.relative.slice(file.relative.lastIndexOf('/') + 1);

    if (TS_CONFIG.test(name)) {
      await readTsConfig(file.path, options, rules, skipped, new Set());
    } else if (VITE_CONFIG.test(name)) {
      await readViteConfig(file.path, options, rules, skipped);
    }
  }

  // Longest prefix first so a more specific mapping wins, then by scope depth so a
  // nested package's config beats the workspace root's, then by source so the order is
  // the same on every run.
  const sorted = [...rules].sort(
    (a, b) =>
      b.prefix.length - a.prefix.length ||
      b.scope.length - a.scope.length ||
      compareStrings(a.source, b.source),
  );

  return { rules: sorted, skipped: skipped.sort((a, b) => compareStrings(a.what, b.what)) };
}

/**
 * Expand an alias-shaped path into candidate absolute POSIX paths, in rule order: longest
 * prefix first, then nearest scope. Returns `[]` when no rule applies, and the resolver then
 * reports the path as `unresolved-alias` rather than `broken`.
 */
export function expandAlias(map: AliasMap, rawPath: string, fromFile: string): readonly string[] {
  const from = toPosix(fromFile);
  const out: string[] = [];

  for (const rule of map.rules) {
    if (!from.startsWith(`${rule.scope}/`) && from !== rule.scope) continue;

    if (rule.wildcard) {
      if (!rawPath.startsWith(rule.prefix)) continue;
      // Leading separators are stripped before joining. A Vite prefix has no trailing
      // slash (`'@': './src'`), so the rest of `@/x.png` is `/x.png`, which
      // `path.resolve(base, '/x.png')` treats as absolute, dropping the base.
      const rest = rawPath.slice(rule.prefix.length).replace(/^[/\\]+/, '');
      for (const target of rule.targets) out.push(toPosix(resolvePath(target, rest)));
    } else {
      if (rawPath !== rule.prefix) continue;
      for (const target of rule.targets) out.push(toPosix(target));
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// tsconfig / jsconfig
// ---------------------------------------------------------------------------

async function readTsConfig(
  path: string,
  options: LoadAliasesOptions,
  rules: AliasRule[],
  skipped: AliasSkip[],
  seen: Set<string>,
): Promise<void> {
  const key = toPosix(path);
  // `extends` can be cyclic, and a cycle here would hang the whole audit.
  if (seen.has(key)) return;
  seen.add(key);

  const source = relativePath(options.root, path);
  const object = await parseObject(path, source, options, skipped);
  if (object === null) return;

  const compilerOptions = objectValued(object, 'compilerOptions');
  const paths = compilerOptions === null ? null : objectValued(compilerOptions, 'paths');
  const baseUrl = compilerOptions === null ? null : stringProperty(compilerOptions, 'baseUrl');

  // `extends` is read first, but the sort in `loadAliases` decides the order rules are
  // tried in. At equal prefix and scope it falls back to the config's path, so an
  // inherited rule can come before a local one, though in TypeScript a local `paths`
  // replaces the inherited one.
  const extendsValue = objectProperty(object, 'extends');
  if (extendsValue !== null) {
    for (const target of extendsTargets(extendsValue)) {
      const resolved = resolveExtends(target, dirname(path), options);
      if (resolved === null) {
        skipped.push({
          what: source,
          reason: `extends "${target}", which could not be found — its aliases were not read`,
        });
        continue;
      }
      await readTsConfig(resolved, options, rules, skipped, seen);
    }
  }

  if (paths === null) return;

  // `paths` is relative to `baseUrl`, which is itself relative to the config's own
  // directory. Absent `baseUrl` means the config's directory, which is what TypeScript
  // does for a `paths` map with no `baseUrl` under `moduleResolution: bundler`.
  const base = resolvePath(dirname(path), baseUrl ?? '.');

  for (const property of paths.properties) {
    const from = propertyKey(property);
    if (from === null || property.type !== 'ObjectProperty') continue;

    const targets = arrayOfStrings(property.value);
    if (targets === null) {
      skipped.push({
        what: source,
        reason: `the alias "${from}" does not map to a list of string paths, so it was not read`,
      });
      continue;
    }

    rules.push(makeRule(from, targets, base, dirname(path), source));
  }
}

/** `"extends": "a"` or `"extends": ["a", "b"]`: TypeScript 5 allows both. */
function extendsTargets(node: t.Expression): readonly string[] {
  if (node.type === 'StringLiteral') return [node.value];
  if (node.type === 'ArrayExpression') {
    return node.elements.flatMap((element) =>
      element?.type === 'StringLiteral' ? [element.value] : [],
    );
  }
  return [];
}

/**
 * Where an `extends` points.
 *
 * A relative or absolute target is taken literally. A bare specifier is a package, found by
 * looking inside `node_modules`. That is allowed because the path is explicit and named:
 * `discover`'s prune keeps that tree out of the asset graph, it does not forbid opening a
 * file there.
 */
function resolveExtends(target: string, from: string, options: LoadAliasesOptions): string | null {
  const direct = target.startsWith('.') || isAbsolute(target) ? resolvePath(from, target) : null;

  if (direct !== null) {
    for (const candidate of [direct, `${direct}.json`]) {
      if (options.exists(candidate)) return candidate;
    }
    return null;
  }

  // A package specifier. Walk up looking for `node_modules/<target>`, adding `.json`
  // the way TypeScript does when the target names no extension.
  let directory = from;
  for (;;) {
    const base = resolvePath(directory, 'node_modules', target);
    for (const candidate of [base, `${base}.json`]) {
      if (options.exists(candidate)) return candidate;
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

// ---------------------------------------------------------------------------
// Vite
// ---------------------------------------------------------------------------

/**
 * Read `resolve.alias` from a Vite config, string values only.
 *
 * Most aliases are computed, such as `'@': path.resolve(__dirname, './src')`, and a config
 * written as a module is not searched at all, so this reads little and reports the rest as
 * unreadable. The alternative is running the file.
 */
async function readViteConfig(
  path: string,
  options: LoadAliasesOptions,
  rules: AliasRule[],
  skipped: AliasSkip[],
): Promise<void> {
  const source = relativePath(options.root, path);
  const text = await readOrSkip(path, source, options, skipped);
  if (text === null) return;

  let ast: t.Expression;
  try {
    // `parseExpression` has no module mode, so only a config whose text is a bare object
    // literal parses; a module throws and is reported below.
    ast = parseExpression(`(${text.replace(/^﻿/, '')})`, {
      plugins: ['typescript'],
      errorRecovery: true,
    });
  } catch {
    // A full module rather than a bare object, which is the ordinary case. Finding the
    // alias object inside it means following imports and `defineConfig`, which this
    // module does not do.
    skipped.push({
      what: source,
      reason:
        'a Vite config is executable JavaScript; only string-literal aliases can be read statically',
    });
    return;
  }

  const resolveSection = ast.type === 'ObjectExpression' ? objectValued(ast, 'resolve') : null;
  const alias = resolveSection === null ? null : objectValued(resolveSection, 'alias');
  if (alias === null) {
    skipped.push({
      what: source,
      reason: 'no statically readable `resolve.alias` object',
    });
    return;
  }

  for (const property of alias.properties) {
    const from = propertyKey(property);
    if (from === null || property.type !== 'ObjectProperty') continue;

    if (property.value.type !== 'StringLiteral') {
      const line = property.value.loc?.start.line;
      skipped.push({
        what: source,
        reason: `the alias "${from}"${line === undefined ? '' : ` at line ${line}`} is computed, not a string literal — Upfly does not execute config files, so it was not read`,
      });
      continue;
    }

    rules.push(
      makeRule(from, [property.value.value], dirname(path), dirname(path), source, 'prefix'),
    );
  }
}

// ---------------------------------------------------------------------------
// shared
// ---------------------------------------------------------------------------

/**
 * Build one rule.
 *
 * `style` exists because the two config formats mean different things by a key. A
 * tsconfig `paths` key is a pattern: `@/*` matches a prefix, `react` only the whole
 * specifier. A Vite `resolve.alias` string key is always a prefix replacement
 * (`{'@': '/src'}` turns `@/x.png` into `/src/x.png`), so it has no `*` to read the
 * intent from and must be told.
 */
function makeRule(
  from: string,
  targets: readonly string[],
  base: string,
  scope: string,
  source: string,
  style: 'pattern' | 'prefix' = 'pattern',
): AliasRule {
  const wildcard = style === 'prefix' || from.endsWith('*');
  const prefix = from.endsWith('*') ? from.slice(0, -1) : from;

  return {
    prefix,
    wildcard,
    scope: toPosix(scope),
    source,
    targets: targets.map((target) =>
      toPosix(resolvePath(base, target.endsWith('*') ? target.slice(0, -1) : target)),
    ),
  };
}

async function parseObject(
  path: string,
  source: string,
  options: LoadAliasesOptions,
  skipped: AliasSkip[],
): Promise<t.ObjectExpression | null> {
  const text = await readOrSkip(path, source, options, skipped);
  if (text === null) return null;

  try {
    // JSONC is a JavaScript object literal: `@babel/parser` takes the comments and
    // trailing commas that make `JSON.parse` throw.
    const ast = parseExpression(text.replace(/^﻿/, ''), {});
    return ast.type === 'ObjectExpression' ? ast : null;
  } catch (error) {
    skipped.push({
      what: source,
      reason: `could not be parsed, so its aliases were not read: ${error instanceof Error ? error.message : String(error)}`,
    });
    return null;
  }
}

async function readOrSkip(
  path: string,
  source: string,
  options: LoadAliasesOptions,
  skipped: AliasSkip[],
): Promise<string | null> {
  try {
    return await options.readFile(path);
  } catch (error) {
    skipped.push({
      what: source,
      reason: `could not be read, so its aliases were not read: ${error instanceof Error ? error.message : String(error)}`,
    });
    return null;
  }
}

/** A property's key when it is a string or a plain name; `null` for any other key. */
function propertyKey(property: t.ObjectExpression['properties'][number]): string | null {
  if (property.type !== 'ObjectProperty') return null;
  if (property.key.type === 'StringLiteral') return property.key.value;
  if (property.key.type === 'Identifier' && !property.computed) return property.key.name;
  return null;
}

/** A property whose value is an object, narrowed so `.properties` is reachable. */
function objectValued(object: t.ObjectExpression, name: string): t.ObjectExpression | null {
  const value = objectProperty(object, name);
  return value !== null && value.type === 'ObjectExpression' ? value : null;
}

function objectProperty(object: t.ObjectExpression, name: string): t.Expression | null {
  for (const property of object.properties) {
    if (propertyKey(property) !== name || property.type !== 'ObjectProperty') continue;
    const { value } = property;
    return value.type === 'ArrayExpression' ||
      value.type === 'ObjectExpression' ||
      value.type === 'StringLiteral' ||
      value.type === 'NumericLiteral'
      ? value
      : null;
  }
  return null;
}

function stringProperty(object: t.ObjectExpression, name: string): string | null {
  const value = objectProperty(object, name);
  return value !== null && value.type === 'StringLiteral' ? value.value : null;
}

function arrayOfStrings(node: t.Node): readonly string[] | null {
  if (node.type !== 'ArrayExpression') return null;
  const out: string[] = [];
  for (const element of node.elements) {
    if (element?.type !== 'StringLiteral') return null;
    out.push(element.value);
  }
  return out;
}
