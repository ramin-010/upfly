/**
 * Read the path aliases a project declares, so `@/assets/logo.png` can resolve.
 *
 * **What this is worth, measured before it was built (A2).** The `unresolved-alias`
 * bucket reads 0 / 4 / 0 across the first three validation repositories, which looks
 * like "almost nothing" — but that bucket only counts references *an adapter already
 * emitted*, so it measures alias usage filtered through adapter coverage. Counted
 * directly, eleven alias-shaped image references exist, seven of them invisible until
 * the Astro adapter landed. **Alias resolution shipped alone moves no number on any
 * validation repo; shipped with the adapter it carries 97% of the value**, because
 * five of the nine `.astro` imports are spelled `~/…`. The two are one feature.
 *
 * ## Three rules this module does not bend
 *
 * ⚠️ **1. A config is read statically or not at all.** Every Vite alias in the corpus
 * is `'@': path.resolve(__dirname, './src')` — a JavaScript expression. Evaluating it
 * would mean executing a config file from a repository the user did not write, in a
 * tool they ran to save bytes. **No byte saving buys arbitrary code execution.** Where
 * the static read cannot see a value, the alias is reported as unreadable with its
 * file and line (rule 9) rather than guessed at or silently dropped.
 *
 * **2. `tsconfig.json` is JSONC, and it is parsed, not regexed.** Comments and
 * trailing commas are legal and common — `shadcn-ui/apps/v4/tsconfig.json` carries a
 * four-line comment *inside* `paths`. `JSON.parse` throws on both. Rather than add a
 * parser dependency or strip comments with a regex (which is "never regex JavaScript"
 * wearing a different extension), this reuses `@babel/parser`: a JSONC document is a
 * JavaScript object literal, and the values are read off the AST rather than
 * reconstructed, so an inherited `__proto__` key is a property like any other.
 *
 * **3. `extends` may reach into `node_modules`, by name only.** `astro-docs` extends
 * `astro/tsconfigs/strict` and shadcn's templates extend
 * `@workspace/typescript-config/nextjs.json`. `discover` prunes `node_modules`, and
 * that prune is **a property of the asset and reference graph, not a filesystem ban**
 * — so following an explicit, named path into it is allowed and *walking* it is not.
 * Nothing found this way can become an asset; it only contributes alias rules.
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
  /** Whether the rule ended in `*` and so matches a prefix rather than the whole path. */
  readonly wildcard: boolean;
  /** Directory the config governs: only references from inside it may use this rule. */
  readonly scope: string;
  /** POSIX-relative config file this came from, so the report can cite it. */
  readonly source: string;
}

/** An alias we could see but could not read. Rule 9 reaches config files too. */
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
  /** Every file `discover` found, claimed or not — no second walk. */
  readonly files: readonly { readonly path: string; readonly relative: string }[];
  readonly readFile: ReadFilePort;
  /** Whether a path exists, for `extends` targets. Same port shape as the resolver's. */
  readonly exists: (path: string) => boolean;
}

const TS_CONFIG = /^(tsconfig(\.[^/]+)?\.json|jsconfig\.json)$/;
const VITE_CONFIG = /^vite\.config\.(js|cjs|mjs|ts|cts|mts)$/;

/**
 * Read every alias the project declares.
 *
 * Pure over the injected ports, like `scan` and `resolve` — the filesystem shows up
 * only as `readFile` and `exists`, so this is unit-testable against a map.
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
  // nested package's config beats the workspace root's, then by source for rule 11.
  const sorted = [...rules].sort(
    (a, b) =>
      b.prefix.length - a.prefix.length ||
      b.scope.length - a.scope.length ||
      compareStrings(a.source, b.source),
  );

  return { rules: sorted, skipped: skipped.sort((a, b) => compareStrings(a.what, b.what)) };
}

/**
 * Expand an alias-shaped path into candidate absolute paths, nearest scope first.
 *
 * Returns `[]` when no rule applies, which is what keeps the resolver's ladder honest:
 * an alias-shaped path with no matching rule stays `unresolved-alias` rather than
 * quietly becoming `broken`.
 */
export function expandAlias(map: AliasMap, rawPath: string, fromFile: string): readonly string[] {
  const from = toPosix(fromFile);
  const out: string[] = [];

  for (const rule of map.rules) {
    if (!from.startsWith(`${rule.scope}/`) && from !== rule.scope) continue;

    if (rule.wildcard) {
      if (!rawPath.startsWith(rule.prefix)) continue;
      // ⚠️ Leading separators stripped before joining. A Vite prefix has no trailing
      // slash (`'@': './src'`), so the remainder of `@/x.png` is `/x.png` — and
      // `path.resolve(base, '/x.png')` treats that as ABSOLUTE and throws the base
      // away, silently resolving to the filesystem root.
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

  // ⚠️ `extends` is followed FIRST, so a local `paths` sorts ahead of an inherited one
  // at equal prefix length rather than behind it.
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

/** `"extends": "a"` or `"extends": ["a", "b"]` — TypeScript 5 allows both. */
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
 * A relative or absolute target is taken literally. A bare specifier is a package, and
 * resolving it means looking inside `node_modules` — permitted here because the path is
 * explicit and named. `discover`'s prune keeps that tree out of the asset graph; it is
 * not a rule against ever opening a file there.
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
 * ⚠️ **Every alias in the validation corpus is computed** —
 * `'@': path.resolve(__dirname, './src')` — so in practice this reads almost nothing
 * and reports almost everything. That is the correct outcome, not a shortfall: the
 * alternative is running the file.
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
    // Wrapped so a module body parses in expression position; `sourceType: module`
    // on `parseExpression` is not a thing, and a config is always an object in the end.
    ast = parseExpression(`(${text.replace(/^﻿/, '')})`, {
      plugins: ['typescript'],
      errorRecovery: true,
    });
  } catch {
    // A full module rather than a bare object — the ordinary case. Finding the alias
    // object inside it means evaluating imports and `defineConfig`, which is the line
    // this module does not cross.
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
 * `style` matters because the two config formats mean different things by a key.
 * A tsconfig `paths` key is a **pattern**: `@/*` matches a prefix, `react` matches the
 * whole specifier and nothing else. A Vite `resolve.alias` **string** key is always a
 * prefix replacement — `{'@': '/src'}` turns `@/x.png` into `/src/x.png` — so it has
 * no `*` to read the intent from and must be told.
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

/** A property's key as written, whether quoted, bare, or numeric. */
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
