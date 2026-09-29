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
import { compareStrings, relativePath, toPosix } from '../paths.js';
import type { ReadFilePort } from '../scan/scan.js';
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
  /**
   * The text a reference must end with, after the part the key's `*` stands for, when a
   * tsconfig key has text after its `*`: `'.svg'` for `'@icons/*.svg'`. Absent when the `*`
   * ends the key.
   */
  readonly suffix?: string;
  /**
   * Absolute directories (or files, for an exact rule) the rule expands a path into, in
   * order. For a wildcard rule, each target's folder: its text up to the last `/` before its
   * `*`.
   */
  readonly targets: readonly string[];
  /**
   * For a wildcard rule, what each target writes after its folder, in `targets`' order, with
   * `*` where the part the key's `*` matched goes: `'*.svg'` for `'src/icons/*.svg'`, `'icon-*'`
   * for `'src/icon-*'`. One with no `*` is used whole, as TypeScript uses such a target.
   * Absent when every target is its folder and a `*`, as `'src/*'` is.
   */
  readonly targetPatterns?: readonly string[];
  /**
   * Whether the rule matches a prefix rather than the whole path: a tsconfig key with a `*`,
   * or a Vite key followed by `/`.
   */
  readonly wildcard: boolean;
  /** Folder of the config that uses the rule: only references from inside it may use it. */
  readonly scope: string;
  /**
   * POSIX-relative config file that writes the rule, so the report can cite it: for an
   * inherited rule, the base it came from.
   */
  readonly source: string;
  /**
   * The tool that applies the rule, which decides how it is chosen: Vite takes the first
   * alias its config declares that matches, TypeScript an exact key, then the longest prefix.
   */
  readonly tool: 'vite' | 'typescript';
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
   * In the order they are tried: Vite's rules first, the nearest config first and each
   * config's in the order it declares them; then tsconfig's, the nearest config first and
   * within one config an exact key, then the longest prefix, so `@/app/(create)/*` beats
   * `@/*` on the same path.
   */
  readonly rules: readonly AliasRule[];
  /**
   * Every tsconfig or jsconfig that serves the files under its folder, nearest first, with the
   * absolute `baseUrl` it uses or `null`. TypeScript reads only a file's nearest config, so one
   * with no `paths` still keeps a parent config's keys from its files, and a module name none
   * of its keys maps is looked for under its `baseUrl`. Absent, as in a map built by hand, the
   * nearest config is the nearest with a key, and no `baseUrl` is known.
   */
  readonly tsconfigs?: readonly { readonly scope: string; readonly baseUrl: string | null }[];
  /**
   * Every Vite config's folder, with the absolute folder Vite serves its project from (the
   * config's `root`, else its own folder), nearest first. Vite loads one config, so a file's
   * nearest config bounds the Vite rules it may use even when that config declares no alias.
   * Absent, as in a map built by hand, the nearest Vite config is the nearest with a rule.
   */
  readonly viteConfigs?: readonly { readonly scope: string; readonly root: string }[];
  readonly skipped: readonly AliasSkip[];
}

/** How `expandAlias` reads a path. */
export interface ExpandOptions {
  /**
   * The path is a module name in an import, so when no rule matches it, it is looked for
   * under the nearest tsconfig's `baseUrl`, as TypeScript looks.
   */
  readonly baseUrl?: boolean;
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
  const tsconfigs: { scope: string; baseUrl: string | null; path: string }[] = [];
  const viteConfigs: { scope: string; root: string }[] = [];
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
      viteConfigs.push(await readViteConfig(file.path, options, rules, skipped));
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
    tsconfigs.push({
      scope: toPosix(dirname(path)),
      baseUrl: baseUrlIn(config, dirname(path)),
      path: toPosix(path),
    });
    // What a config in this chain could not read, this config's files lose.
    for (const skip of skipped) {
      if (skip.config !== null && config.visited.has(skip.config)) {
        skip.scopes.add(toPosix(dirname(path)));
      }
    }
  }

  // Vite's alias plugin runs before any other resolver, a plugin reading tsconfig `paths`
  // included, so Vite's rules come first. Then the nearest config first, as each tool reads
  // only the nearest. Within one Vite config, the order it declares, which the stable sort
  // keeps; within one tsconfig, TypeScript's: an exact key, then the longest prefix, so
  // `@/app/(create)/*` beats `@/*`. Then by source, so the order is the same on every run.
  const sorted = unique(rules).sort(
    (a, b) =>
      Number(a.tool === 'typescript') - Number(b.tool === 'typescript') ||
      b.scope.length - a.scope.length ||
      (a.tool === 'vite'
        ? 0
        : Number(a.wildcard) - Number(b.wildcard) || b.prefix.length - a.prefix.length) ||
      compareStrings(a.source, b.source),
  );

  return {
    rules: sorted,
    tsconfigs: byFolder(tsconfigs),
    viteConfigs: viteConfigs.sort(
      (a, b) => b.scope.length - a.scope.length || compareStrings(a.scope, b.scope),
    ),
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
 * Expand an alias-shaped path into candidate absolute POSIX paths: the targets of the rule
 * `matchingRule` chooses, in order. With `baseUrl`, a module name no rule matches is looked
 * for under the nearest tsconfig's `baseUrl`; TypeScript tries it only when no key matches,
 * so a key whose targets miss has no fallback. Returns `[]` when nothing applies.
 */
export function expandAlias(
  map: AliasMap,
  rawPath: string,
  fromFile: string,
  options: ExpandOptions = {},
): readonly string[] {
  const rule = matchingRule(map, rawPath, fromFile);
  if (rule !== null) return expandRule(rule, rawPath);
  const baseUrl =
    options.baseUrl === true ? (nearestTsconfig(map, toPosix(fromFile))?.baseUrl ?? null) : null;
  return baseUrl === null ? [] : [toPosix(resolvePath(baseUrl, rawPath))];
}

/**
 * The one rule that maps `rawPath` written in `fromFile`, chosen as the tool that applies it
 * chooses, or `null`. A file is built by its nearest Vite config and typed by its nearest
 * tsconfig, so only those two configs' rules apply, Vite's first. Vite takes the first alias
 * it declares that matches and tries nothing after it; TypeScript takes an exact key, else the
 * longest matching prefix, and tries only that key's targets. No other rule is a fallback: a
 * path those targets miss is unresolved for the tool too.
 */
export function matchingRule(map: AliasMap, rawPath: string, fromFile: string): AliasRule | null {
  const from = toPosix(fromFile);
  // The folder of the nearest config of each tool, from `viteConfigs` and `tsconfigs`, where a
  // config with no alias or key counts too; else from the first rule in scope, since the rules
  // come nearest config first.
  const nearest: Record<AliasRule['tool'], string | null> = {
    vite: map.viteConfigs?.find((config) => serves(config.scope, from))?.scope ?? null,
    typescript: nearestTsconfig(map, from)?.scope ?? null,
  };

  for (const rule of map.rules) {
    if (!serves(rule.scope, from)) continue;
    nearest[rule.tool] ??= rule.scope;
    if (rule.scope !== nearest[rule.tool]) continue;
    if (rule.wildcard ? fitsPattern(rule, rawPath) : rawPath === rule.prefix) return rule;
  }
  return null;
}

/** Whether a config in `scope` serves `file`: the file is in that folder or below it. */
function serves(scope: string, file: string): boolean {
  return file.startsWith(`${scope}/`) || file === scope;
}

/** The nearest tsconfig that serves a POSIX file, when the map records its tsconfigs. */
function nearestTsconfig(map: AliasMap, file: string) {
  return map.tsconfigs?.find(({ scope }) => serves(scope, file));
}

/** Whether a path starts with the rule's prefix and ends with its suffix, the two apart. */
function fitsPattern(rule: AliasRule, rawPath: string): boolean {
  const suffix = rule.suffix ?? '';
  return (
    rawPath.length >= rule.prefix.length + suffix.length &&
    rawPath.startsWith(rule.prefix) &&
    rawPath.endsWith(suffix)
  );
}

/**
 * The paths a rule that matches `rawPath` expands it to: the part the key's `*` matched put
 * where each target's `*` is, as TypeScript substitutes it.
 */
function expandRule(rule: AliasRule, rawPath: string): string[] {
  if (!rule.wildcard) return rule.targets.map((target) => toPosix(target));
  const matched = rawPath.slice(rule.prefix.length, rawPath.length - (rule.suffix ?? '').length);
  return rule.targets.map((target, index) => {
    const rest = (rule.targetPatterns?.[index] ?? '*').replace('*', () => matched);
    // Leading separators are stripped before joining. Under a key with no trailing slash,
    // such as `"@*"`, the rest of `@/x.png` is `/x.png`, which
    // `path.resolve(base, '/x.png')` treats as absolute, dropping the base.
    return toPosix(resolvePath(target, rest.replace(/^[/\\]+/, '')));
  });
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
  const base = baseUrlIn(config, folder) ?? dirname(declaredIn.path);

  const rules: AliasRule[] = [];
  for (const property of map.properties) {
    const from = propertyKey(property);
    if (from === null || property.type !== 'ObjectProperty') continue;

    const targets = arrayOfStrings(property.value);
    // TypeScript reports a key with a second `*` and matches nothing with it.
    if (targets === null || from.indexOf('*') !== from.lastIndexOf('*')) {
      const problem =
        targets === null
          ? 'does not map to a list of string paths'
          : 'has more than one "*", which TypeScript does not accept';
      const key = JSON.stringify([declaredIn.source, from]);
      let skip = context.reported.get(key);
      if (skip === undefined) {
        skip = {
          what: declaredIn.source,
          reason: `the alias "${from}" ${problem}, so it was not read`,
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

    rules.push(makeRule(from, targets.map(fill), base, folder, declaredIn.source, 'typescript'));
  }
  return rules;
}

/** The absolute `baseUrl` a config uses, `${configDir}` read as its own folder, or `null`. */
function baseUrlIn(config: EffectiveConfig, folder: string): string | null {
  if (config.baseUrl === null) return null;
  return toPosix(resolvePath(config.baseUrl.replace(CONFIG_DIR, () => toPosix(folder))));
}

/**
 * One entry per folder, nearest first. Configs in one folder serve its files together, as
 * their keys do, and the first by name that sets a `baseUrl` gives it.
 */
function byFolder(
  configs: readonly {
    readonly scope: string;
    readonly baseUrl: string | null;
    readonly path: string;
  }[],
): { readonly scope: string; readonly baseUrl: string | null }[] {
  const folders = new Map<string, string | null>();
  for (const { scope, baseUrl } of [...configs].sort((a, b) => compareStrings(a.path, b.path))) {
    if ((folders.get(scope) ?? null) === null) folders.set(scope, baseUrl);
  }
  return [...folders]
    .map(([scope, baseUrl]) => ({ scope, baseUrl }))
    .sort((a, b) => b.scope.length - a.scope.length || compareStrings(a.scope, b.scope));
}

/** Rules that say exactly the same thing, such as one config and another extending it. */
function unique(rules: readonly AliasRule[]): AliasRule[] {
  const seen = new Set<string>();
  return rules.filter((rule) => {
    const key = JSON.stringify([
      rule.prefix,
      rule.suffix,
      rule.wildcard,
      rule.scope,
      rule.source,
      rule.targets,
      rule.targetPatterns,
    ]);
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
): Promise<{ scope: string; root: string }> {
  const source = relativePath(options.root, path);
  const scope = toPosix(dirname(path));
  // Nothing extends a Vite config: what it could not read, its own folder loses.
  const skip = (reason: string) =>
    skipped.push({ what: source, reason, scopes: new Set([scope]), config: null });
  const text = await readOrSkip(path, options, skip);
  // Vite still loads a config Upfly cannot read, so it bounds its folder all the same.
  if (text === null) return { scope, root: scope };

  const { entries, unread, root } = readViteAliases(text, path);
  for (const { find, target } of entries) {
    rules.push(makeRule(find, [target], dirname(path), dirname(path), source, 'vite'));
    rules.push(
      makeRule(`${find}/*`, [`${target}/*`], dirname(path), dirname(path), source, 'vite', true),
    );
  }
  for (const item of unread) skip(item.reason);
  return { scope, root: toPosix(root) };
}

// ---------------------------------------------------------------------------
// shared
// ---------------------------------------------------------------------------

/**
 * Build one rule from a key in tsconfig's form: `@/*` matches a prefix, `react` the whole path.
 *
 * @param vitePrefix For a Vite alias, whether this is the rule for the key followed by `/`,
 *   whose `*` the caller appended. Vite matches a key as written, so a key `@/*` is text: it
 *   matches the path `@/*` itself, or that text and a slash before the rest, never `@/x.png`.
 */
function makeRule(
  from: string,
  targets: readonly string[],
  base: string,
  scope: string,
  source: string,
  tool: AliasRule['tool'],
  vitePrefix = false,
): AliasRule {
  // TypeScript reads a key's one `*` wherever it is. Vite reads none of a key's own.
  const starOf = (text: string) =>
    tool === 'typescript' ? text.indexOf('*') : vitePrefix ? text.length - 1 : -1;
  const star = starOf(from);
  const common = { scope: toPosix(scope), source, tool };

  if (star === -1) {
    // TypeScript puts what the key's absent `*` matched, nothing, where a target's `*` is;
    // Vite uses a replacement whole.
    const whole = (target: string) =>
      tool === 'typescript' && target.endsWith('*') ? target.slice(0, -1) : target;
    return {
      ...common,
      prefix: from,
      wildcard: false,
      targets: targets.map((target) => toPosix(resolvePath(base, whole(target)))),
    };
  }

  const suffix = from.slice(star + 1);
  const parts = targets.map((target) => {
    const at = starOf(target);
    const cut = target.lastIndexOf('/', (at === -1 ? target.length : at) - 1) + 1;
    return { folder: target.slice(0, cut), pattern: target.slice(cut) };
  });
  return {
    ...common,
    prefix: from.slice(0, star),
    ...(suffix === '' ? {} : { suffix }),
    wildcard: true,
    targets: parts.map(({ folder }) => toPosix(resolvePath(base, folder))),
    ...(parts.every(({ pattern }) => pattern === '*')
      ? {}
      : { targetPatterns: parts.map(({ pattern }) => pattern) }),
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
