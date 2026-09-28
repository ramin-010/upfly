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

import { basename, dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { parseExpression } from '@babel/parser';
import type * as t from '@babel/types';
import { compareStrings, relativePath, toPosix } from './paths.js';
import type { ReadFilePort } from './scan/scan.js';
import { readViteAliases } from './vite-config.js';

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
   * `*`, or a Vite key followed by `/`.
   */
  readonly wildcard: boolean;
  /** Folder of the config that uses the rule: only references from inside it may use it. */
  readonly scope: string;
  /**
   * POSIX-relative config file that writes the rule, so the report can cite it: for an
   * inherited rule, the base it came from.
   */
  readonly source: string;
}

/** A config or alias that was found but could not be read, kept so the report can say why. */
export interface AliasSkip {
  /** POSIX-relative config file. */
  readonly what: string;
  readonly reason: string;
  /**
   * Absolute POSIX folders whose files lose what could not be read, as `AliasRule.scope` is:
   * the folder of each config that uses the setting, itself or through `extends`, or a Vite
   * config's own folder.
   */
  readonly scopes: readonly string[];
}

/**
 * A skip recorded while the configs are read. When a tsconfig or jsconfig file itself could
 * not be read, `config` is its path, and `scopes` gains the folder of every config whose
 * `extends` chain reaches it, which is known only once every chain has been followed.
 */
interface PendingSkip {
  readonly what: string;
  readonly reason: string;
  readonly scopes: Set<string>;
  readonly config: string | null;
}

export interface AliasMap {
  /**
   * Nearest config first; within one config an exact key, then the longest prefix, so
   * `@/app/(create)/*` beats `@/*` on the same path.
   */
  readonly rules: readonly AliasRule[];
  readonly skipped: readonly AliasSkip[];
}

export interface LoadAliasesOptions {
  /** Absolute project root. */
  readonly root: string;
  /** Every file `discover` found, claimed or not, so there is no second walk. */
  readonly files: readonly { readonly path: string; readonly relative: string }[];
  readonly readFile: ReadFilePort;
  /**
   * Whether a path is a file, for `extends` targets. A folder answers `false`: TypeScript
   * never reads a folder as a config.
   */
  readonly isFile: (path: string) => boolean;
}

const TS_CONFIG = /^(tsconfig(\.[^/]+)?\.json|jsconfig\.json)$/;
const VITE_CONFIG = /^vite\.config\.(js|cjs|mjs|ts|cts|mts)$/;

/**
 * Read every alias the project declares. An alias that cannot be read statically is
 * returned in `skipped` with a reason, never evaluated.
 *
 * The filesystem is reached only through `readFile` and `isFile`, so this can be tested
 * against an in-memory map.
 */
export async function loadAliases(options: LoadAliasesOptions): Promise<AliasMap> {
  const rules: AliasRule[] = [];
  const skipped: PendingSkip[] = [];
  const context: TsContext = {
    options,
    skipped,
    parsed: new Map(),
    bases: new Set(),
    reported: new Map(),
  };

  const tsConfigs: string[] = [];
  for (const file of options.files) {
    const name = file.relative.slice(file.relative.lastIndexOf('/') + 1);

    if (TS_CONFIG.test(name)) {
      tsConfigs.push(file.path);
    } else if (VITE_CONFIG.test(name)) {
      await readViteConfig(file.path, options, rules, skipped);
    }
  }

  // Every chain is merged before any rule is made, because only then is it known which
  // configs are bases that other configs extend.
  const effective = new Map<string, EffectiveConfig>();
  for (const path of tsConfigs) effective.set(path, await effectiveConfig(path, [], context));

  for (const path of tsConfigs) {
    // A base serves files only through the configs that extend it, as it does in
    // TypeScript. A `tsconfig.json` is still the project config of its own folder.
    const isProject = ['tsconfig.json', 'jsconfig.json'].includes(basename(path));
    if (context.bases.has(toPosix(path)) && !isProject) continue;
    const config = effective.get(path);
    if (config === undefined) continue;
    rules.push(...rulesOf(config, dirname(path), context));
    // What a config in this chain could not read, this config's files lose.
    for (const skip of skipped) {
      if (skip.config !== null && config.visited.has(skip.config)) {
        skip.scopes.add(toPosix(dirname(path)));
      }
    }
  }

  // Nearest config first, as TypeScript reads only the nearest. Within one config, the order
  // TypeScript takes: an exact key, then the longest prefix, so `@/app/(create)/*` beats
  // `@/*`. Then by source, so the order is the same on every run.
  const sorted = unique(rules).sort(
    (a, b) =>
      b.scope.length - a.scope.length ||
      Number(a.wildcard) - Number(b.wildcard) ||
      b.prefix.length - a.prefix.length ||
      compareStrings(a.source, b.source),
  );

  return {
    rules: sorted,
    skipped: skipped
      .map(({ what, reason, scopes }) => ({
        what,
        reason,
        scopes: [...scopes].sort(compareStrings),
      }))
      .sort((a, b) => compareStrings(a.what, b.what)),
  };
}

/**
 * Expand an alias-shaped path into candidate absolute POSIX paths, in rule order: the nearest
 * config's rules first, then each parent folder's as a fallback. Returns `[]` when no rule
 * applies, and the resolver then reports the path as `unresolved-alias` rather than `broken`.
 */
export function expandAlias(map: AliasMap, rawPath: string, fromFile: string): readonly string[] {
  const from = toPosix(fromFile);
  const out: string[] = [];

  for (const rule of map.rules) {
    if (!from.startsWith(`${rule.scope}/`) && from !== rule.scope) continue;

    if (rule.wildcard) {
      if (!rawPath.startsWith(rule.prefix)) continue;
      // Leading separators are stripped before joining. Under a key with no trailing slash,
      // such as `"@*"`, the rest of `@/x.png` is `/x.png`, which
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

/** What reading every tsconfig shares: each file is parsed and reported once. */
interface TsContext {
  readonly options: LoadAliasesOptions;
  readonly skipped: PendingSkip[];
  readonly parsed: Map<string, Promise<ParsedConfig | null>>;
  /** POSIX paths of every config another config extends. */
  readonly bases: Set<string>;
  /** Skips already recorded, so a base shared by several configs is reported once. */
  readonly reported: Map<string, PendingSkip>;
}

/** The settings of one tsconfig that aliases depend on, as the file writes them. */
interface ParsedConfig {
  readonly path: string;
  readonly source: string;
  /** The configs its `extends` names, found, in order. */
  readonly extends: readonly string[];
  readonly paths: t.ObjectExpression | null;
  readonly baseUrl: string | null;
}

/** A config's aliases once `extends` is applied: the `paths` in force and the `baseUrl`. */
interface EffectiveConfig {
  readonly paths: { readonly map: t.ObjectExpression; readonly declaredIn: ParsedConfig } | null;
  /** Absolute, or still starting with `${configDir}`, which only the using config can fill. */
  readonly baseUrl: string | null;
  /** POSIX paths of every config the chain holds, itself included, read or not. */
  readonly visited: ReadonlySet<string>;
}

const CONFIG_DIR = /^\$\{configDir\}/i;

/**
 * A config's `paths` and `baseUrl` after `extends`, merged as TypeScript merges them: each
 * base in order, then the config's own settings, an option later in the chain replacing an
 * earlier one whole. A config already on `stack` is skipped, which breaks a cycle.
 */
async function effectiveConfig(
  path: string,
  stack: readonly string[],
  context: TsContext,
): Promise<EffectiveConfig> {
  const visited = new Set([toPosix(path)]);
  const config = await parsedConfig(path, context);
  if (config === null) return { paths: null, baseUrl: null, visited };

  let paths: EffectiveConfig['paths'] = null;
  let baseUrl: string | null = null;
  const chain = [...stack, toPosix(path)];

  for (const base of config.extends) {
    if (chain.includes(toPosix(base))) continue;
    context.bases.add(toPosix(base));
    const inherited = await effectiveConfig(base, chain, context);
    paths = inherited.paths ?? paths;
    baseUrl = inherited.baseUrl ?? baseUrl;
    for (const file of inherited.visited) visited.add(file);
  }

  if (config.paths !== null) paths = { map: config.paths, declaredIn: config };
  if (config.baseUrl !== null) {
    // A `baseUrl` is read against the config that declares it, wherever it is inherited.
    baseUrl = CONFIG_DIR.test(config.baseUrl)
      ? config.baseUrl
      : resolvePath(dirname(path), config.baseUrl);
  }
  return { paths, baseUrl, visited };
}

/** Read one config, once, with every `extends` it names found or reported. */
function parsedConfig(path: string, context: TsContext): Promise<ParsedConfig | null> {
  const key = toPosix(path);
  let pending = context.parsed.get(key);
  if (pending === undefined) {
    pending = parseTsConfig(path, context);
    context.parsed.set(key, pending);
  }
  return pending;
}

async function parseTsConfig(path: string, context: TsContext): Promise<ParsedConfig | null> {
  const { options, skipped } = context;
  const source = relativePath(options.root, path);
  const skip = (reason: string) =>
    skipped.push({ what: source, reason, scopes: new Set(), config: toPosix(path) });
  const object = await parseObject(path, options, skip);
  if (object === null) return null;

  const compilerOptions = objectValued(object, 'compilerOptions');
  const bases: string[] = [];
  const extendsValue = objectProperty(object, 'extends');
  for (const target of extendsValue === null ? [] : extendsTargets(extendsValue)) {
    const resolved = await resolveExtends(target, dirname(path), options);
    if (resolved === null) {
      skip(`extends "${target}", which could not be found, so its aliases were not read`);
      continue;
    }
    bases.push(resolved);
  }

  return {
    path,
    source,
    extends: bases,
    paths: compilerOptions === null ? null : objectValued(compilerOptions, 'paths'),
    baseUrl: compilerOptions === null ? null : stringProperty(compilerOptions, 'baseUrl'),
  };
}

/**
 * The rules one config uses, serving the files under its folder. Targets are read against
 * the `baseUrl` in force, else against the folder of the config that wrote `paths`, and
 * `${configDir}` at the start of either is the using config's folder.
 */
function rulesOf(config: EffectiveConfig, folder: string, context: TsContext): AliasRule[] {
  if (config.paths === null) return [];
  const { map, declaredIn } = config.paths;
  const fill = (value: string) => value.replace(CONFIG_DIR, () => toPosix(folder));
  const base = config.baseUrl === null ? dirname(declaredIn.path) : fill(config.baseUrl);

  const rules: AliasRule[] = [];
  for (const property of map.properties) {
    const from = propertyKey(property);
    if (from === null || property.type !== 'ObjectProperty') continue;

    const targets = arrayOfStrings(property.value);
    if (targets === null) {
      const key = JSON.stringify([declaredIn.source, from]);
      let skip = context.reported.get(key);
      if (skip === undefined) {
        skip = {
          what: declaredIn.source,
          reason: `the alias "${from}" does not map to a list of string paths, so it was not read`,
          scopes: new Set(),
          config: null,
        };
        context.reported.set(key, skip);
        context.skipped.push(skip);
      }
      // Only the configs whose `paths` holds the alias lose it, not every config whose
      // chain passes through the file that writes it.
      skip.scopes.add(toPosix(folder));
      continue;
    }

    rules.push(makeRule(from, targets.map(fill), base, folder, declaredIn.source));
  }
  return rules;
}

/** Rules that say exactly the same thing, such as one config and another extending it. */
function unique(rules: readonly AliasRule[]): AliasRule[] {
  const seen = new Set<string>();
  return rules.filter((rule) => {
    const key = JSON.stringify([rule.prefix, rule.wildcard, rule.scope, rule.source, rule.targets]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
 * The config an `extends` names, found as TypeScript finds it, or `null`.
 *
 * A rooted path, or one starting `./` or `../`, names a file, with `.json` added when that
 * file is missing; a folder is never a config. Anything else is a package, looked for in
 * `node_modules` from the config's folder up: its own config (the `tsconfig` field of its
 * `package.json`, else its `tsconfig.json`), or a path inside it (that file, `.json` added,
 * or that folder's `tsconfig.json`). A package's `exports` map is not followed. Reading a
 * file in `node_modules` is allowed because the path is explicit and named: `discover`'s
 * prune keeps that tree out of the asset graph, it does not forbid opening a file there.
 */
async function resolveExtends(
  target: string,
  from: string,
  options: LoadAliasesOptions,
): Promise<string | null> {
  const written = target.replaceAll('\\', '/');
  if (isAbsolute(written) || written.startsWith('./') || written.startsWith('../')) {
    return fileOrJson(resolvePath(from, written), options);
  }

  const [first = '', second = '', ...rest] = written.split('/');
  const scoped = first.startsWith('@');
  const name = scoped ? `${first}/${second}` : first;
  const inside = (scoped ? rest : [second, ...rest]).filter((part) => part !== '').join('/');

  let directory = from;
  for (;;) {
    const root = resolvePath(directory, 'node_modules', name);
    const found = await packageConfig(root, inside, options);
    if (found !== null) return found;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/** The config a package at `root` offers, or the one at `inside` it. */
async function packageConfig(
  root: string,
  inside: string,
  options: LoadAliasesOptions,
): Promise<string | null> {
  if (inside !== '') {
    const path = resolvePath(root, inside);
    return fileOrJson(path, options) ?? fileOrNull(resolvePath(path, 'tsconfig.json'), options);
  }
  const field = await tsconfigField(resolvePath(root, 'package.json'), options);
  const declared = field === null ? null : fileOrJson(resolvePath(root, field), options);
  return declared ?? fileOrNull(resolvePath(root, 'tsconfig.json'), options);
}

/** `path` when it is a file, else `path.json` when `path` has no such ending and that is. */
function fileOrJson(path: string, options: LoadAliasesOptions): string | null {
  if (options.isFile(path)) return path;
  return !path.endsWith('.json') ? fileOrNull(`${path}.json`, options) : null;
}

function fileOrNull(path: string, options: LoadAliasesOptions): string | null {
  return options.isFile(path) ? path : null;
}

/** The `tsconfig` field of a `package.json`, when the file has one that is a string. */
async function tsconfigField(path: string, options: LoadAliasesOptions): Promise<string | null> {
  if (!options.isFile(path)) return null;
  try {
    const manifest: unknown = JSON.parse(await options.readFile(path));
    if (typeof manifest !== 'object' || manifest === null || !('tsconfig' in manifest)) return null;
    return typeof manifest.tsconfig === 'string' ? manifest.tsconfig : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Vite
// ---------------------------------------------------------------------------

/**
 * Read `resolve.alias` from a Vite config without running it; `readViteAliases` says what it
 * can read. A Vite key replaces a path that is the key or starts with the key and a `/`, so
 * each alias makes two rules: `@` matches `@` and `@/x.png`, never `@img/x.png`.
 */
async function readViteConfig(
  path: string,
  options: LoadAliasesOptions,
  rules: AliasRule[],
  skipped: PendingSkip[],
): Promise<void> {
  const source = relativePath(options.root, path);
  // Nothing extends a Vite config: what it could not read, its own folder loses.
  const skip = (reason: string) =>
    skipped.push({ what: source, reason, scopes: new Set([toPosix(dirname(path))]), config: null });
  const text = await readOrSkip(path, options, skip);
  if (text === null) return;

  const { entries, unread } = readViteAliases(text, path);
  for (const { find, target } of entries) {
    rules.push(makeRule(find, [target], dirname(path), dirname(path), source));
    rules.push(makeRule(`${find}/*`, [`${target}/*`], dirname(path), dirname(path), source));
  }
  for (const item of unread) skip(item.reason);
}

// ---------------------------------------------------------------------------
// shared
// ---------------------------------------------------------------------------

/** Build one rule from a key in tsconfig's form: `@/*` matches a prefix, `react` the whole path. */
function makeRule(
  from: string,
  targets: readonly string[],
  base: string,
  scope: string,
  source: string,
): AliasRule {
  const wildcard = from.endsWith('*');
  const prefix = wildcard ? from.slice(0, -1) : from;

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
  options: LoadAliasesOptions,
  skip: (reason: string) => void,
): Promise<t.ObjectExpression | null> {
  const text = await readOrSkip(path, options, skip);
  if (text === null) return null;

  try {
    // JSONC is a JavaScript object literal: `@babel/parser` takes the comments and
    // trailing commas that make `JSON.parse` throw.
    const ast = parseExpression(text.replace(/^﻿/, ''), {});
    return ast.type === 'ObjectExpression' ? ast : null;
  } catch {
    // The parser's own words change between versions and are no report's business.
    skip('could not be parsed, so its aliases were not read');
    return null;
  }
}

async function readOrSkip(
  path: string,
  options: LoadAliasesOptions,
  skip: (reason: string) => void,
): Promise<string | null> {
  try {
    return await options.readFile(path);
  } catch (error) {
    // The error code alone: the message names the absolute path, which no report carries.
    const code = error instanceof Error && 'code' in error ? String(error.code) : null;
    skip(`could not be read${code === null ? '' : ` (${code})`}, so its aliases were not read`);
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
