/**
 * `loadAliases` and `expandAlias` against TypeScript's own module resolution, over configs
 * drawn at random: `extends` chains (arrays, cycles, packages), `baseUrl`, `${configDir}` and
 * nested projects. TypeScript is asked through its public API and sees a module at every path
 * a probe name can reach outside `node_modules`, and Upfly's answer is its first candidate
 * where such a module stands, so both say which file an import loads, or that none does.
 *
 * Then against Vite's, over `resolve.alias` sections drawn at random. Vite is asked through
 * its public `createIdResolver` in alias-only mode, which runs the alias plugin Vite ships and
 * nothing else, so its answer is the path Vite goes on to load.
 */

import { posix, resolve } from 'node:path';
import ts from 'typescript';
import { BuildEnvironment, createIdResolver, resolveConfig } from 'vite';
import { describe, expect, it } from 'vitest';
import { toPosix } from '../paths.js';
import { expandAlias, loadAliases } from './aliases.js';

const ROOT = toPosix(resolve('/project'));
const ROUNDS = 200;
// About a second alone, most of it loading TypeScript; the gate runs many files beside it.
const TIMEOUT_MS = 60_000;

/** Where a config can sit. The two in `node_modules` are reached only through `extends`. */
const CONFIGS = [
  'tsconfig.json',
  'apps/web/tsconfig.json',
  'apps/web/sub/tsconfig.json',
  'packages/ui/tsconfig.json',
  'configs/base.json',
  'configs/strict.json',
  'node_modules/@acme/tsconfig/base.json',
  'node_modules/@acme/tsconfig/tsconfig.json',
];
/**
 * `@icons/*.svg` has text after its `*`, and ties `@icons/*` on prefix length, which TypeScript
 * settles by the order the keys are written. `*` maps every name, so `baseUrl` never answers.
 */
const KEYS = [
  '@/*',
  '~/*',
  '#lib/*',
  '@/components/*',
  '$lib',
  '$lib/*',
  '@icons/*.svg',
  '@icons/*',
  '*',
];
/** Names with no alias's first character, which only `baseUrl`, a `*` key or a package finds. */
const BARE = ['probe', 'src/probe'];
/** With text after the `*`, text before it in the same name, and no `*` at all. */
const PATTERN_TARGETS = [
  './src/*',
  'src/*',
  '../shared/*',
  '*',
  '${configDir}/lib/*',
  './gen/*',
  './src/icons/*.svg',
  './gen/icon-*',
  'lib',
];
const EXACT_TARGETS = ['./src/lib', '${configDir}/src/lib', 'lib'];
const BASE_URLS = ['.', './src', '..', '${configDir}/src', '${configDir}'];

/** Mulberry32, so a failing round can be replayed from its number alone. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, list: readonly T[]): T {
  const item = list[Math.floor(random() * list.length)];
  if (item === undefined) throw new Error('pick needs a list with items');
  return item;
}

/** An `extends` value as people write one: relative, with or without `.json`, or a package. */
function spellExtends(from: string, to: string, random: () => number): string {
  if (to === 'node_modules/@acme/tsconfig/tsconfig.json') return '@acme/tsconfig';
  if (to.startsWith('node_modules/')) {
    return random() < 0.5 ? '@acme/tsconfig/base.json' : '@acme/tsconfig/base';
  }
  const relative = posix.relative(posix.dirname(from), to);
  const spelled = relative.startsWith('.') ? relative : `./${relative}`;
  return random() < 0.25 ? spelled.replace(/\.json$/, '') : spelled;
}

function pathsOf(random: () => number): Record<string, string[]> {
  const paths: Record<string, string[]> = {};
  const count = 1 + Math.floor(random() * 3);
  for (let i = 0; i < count; i++) {
    const key = pick(random, KEYS);
    paths[key] = key.includes('*')
      ? [pick(random, PATTERN_TARGETS), ...(random() < 0.3 ? [pick(random, PATTERN_TARGETS)] : [])]
      : [pick(random, EXACT_TARGETS)];
  }
  return paths;
}

function configText(path: string, chosen: readonly string[], random: () => number): string {
  const config: { extends?: string | string[]; compilerOptions?: Record<string, unknown> } = {};
  if (random() < 0.6) {
    // A config names itself now and then, which TypeScript and Upfly both treat as a cycle.
    const others = chosen.filter((other) => other !== path || random() < 0.1);
    const count = random() < 0.7 ? 1 : 2 + Math.floor(random() * 2);
    const targets = Array.from({ length: count }, () =>
      spellExtends(path, pick(random, others), random),
    );
    const [only] = targets;
    config.extends = targets.length === 1 && only !== undefined && random() < 0.8 ? only : targets;
  }
  const options: Record<string, unknown> = {};
  if (random() < 0.4) options.baseUrl = pick(random, BASE_URLS);
  if (random() < 0.6) options.paths = pathsOf(random);
  if (Object.keys(options).length > 0) config.compilerOptions = options;
  return JSON.stringify(config);
}

/** One round's configs, by absolute POSIX path. */
function generate(random: () => number): Map<string, string> {
  const count = 2 + Math.floor(random() * 4);
  const chosen = CONFIGS.map((path) => ({ path, order: random() }))
    .sort((a, b) => a.order - b.order)
    .slice(0, count)
    .map(({ path }) => path);

  const files = new Map<string, string>();
  for (const path of chosen) files.set(`${ROOT}/${path}`, configText(path, chosen, random));
  if (chosen.some((path) => path.startsWith('node_modules/')) && random() < 0.5) {
    files.set(
      `${ROOT}/node_modules/@acme/tsconfig/package.json`,
      JSON.stringify({ name: '@acme/tsconfig', tsconfig: './base.json' }),
    );
  }
  return files;
}

function relative(path: string): string {
  return path.startsWith(`${ROOT}/`) ? path.slice(ROOT.length + 1) : path;
}

function typescriptHost(
  files: ReadonlyMap<string, string>,
): ts.ParseConfigFileHost & ts.ModuleResolutionHost {
  // A module stands at every path a probe name can reach, `.ts` added: `probe`, `icon-probe`,
  // `probe.svg` and `lib`. None in `node_modules`, where Upfly looks for no module: a package
  // is a question for the resolver's other rungs.
  const probe = /(probe|\/lib)(\.svg)?\.ts$/;
  const isModule = (path: string) => probe.test(path) && !path.includes('/node_modules/');
  return {
    useCaseSensitiveFileNames: true,
    getCurrentDirectory: () => ROOT,
    readDirectory: () => [],
    directoryExists: () => true,
    fileExists: (path) => files.has(toPosix(path)) || isModule(toPosix(path)),
    readFile: (path) =>
      files.get(toPosix(path)) ?? (isModule(toPosix(path)) ? 'export {};' : undefined),
    onUnRecoverableConfigFileDiagnostic: () => {},
  };
}

interface Disagreement {
  readonly round: number;
  readonly from: string;
  readonly specifier: string;
  readonly typescript: string;
  readonly upfly: string;
  readonly files: Readonly<Record<string, string>>;
}

/** Every name some project's key gives, and the bare ones, asked from every project folder. */
async function disagreements(
  round: number,
  files: ReadonlyMap<string, string>,
): Promise<{
  readonly probes: number;
  readonly loaded: number;
  readonly found: readonly Disagreement[];
}> {
  const discovered = [...files.keys()]
    .filter((path) => !path.includes('/node_modules/'))
    .map((path) => ({ path, relative: relative(path) }));
  const map = await loadAliases({
    root: ROOT,
    files: discovered,
    readFile: async (path) => {
      const text = files.get(toPosix(path));
      if (text === undefined) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      return text;
    },
    isFile: (path) => files.has(toPosix(path)),
  });

  const host = typescriptHost(files);
  const projects = discovered
    .filter(({ path }) => posix.basename(path) === 'tsconfig.json')
    .map(({ path }) => ({
      folder: posix.dirname(path),
      options: ts.getParsedCommandLineOfConfigFile(path, {}, host)?.options ?? {},
    }));
  const specifiers = new Set([
    ...projects.flatMap(({ options }) =>
      Object.keys(options.paths ?? {}).map((key) => key.replace('*', 'probe')),
    ),
    ...BARE,
  ]);

  let probes = 0;
  let loaded = 0;
  const found: Disagreement[] = [];
  for (const { folder, options } of projects) {
    const from = `${folder}/main.ts`;
    for (const specifier of specifiers) {
      probes += 1;
      const resolved = ts.resolveModuleName(specifier, from, options, host).resolvedModule;
      // The resolver takes the first candidate that names a file, as TypeScript does.
      const first = expandAlias(map, specifier, from, { baseUrl: true }).find((candidate) =>
        host.fileExists(`${candidate}.ts`),
      );
      const typescript = resolved === undefined ? '(none)' : relative(resolved.resolvedFileName);
      const upfly = first === undefined ? '(none)' : relative(`${first}.ts`);
      if (resolved !== undefined) loaded += 1;
      if (typescript === upfly) continue;
      found.push({
        round,
        from: relative(folder) || '.',
        specifier,
        typescript,
        upfly,
        files: Object.fromEntries([...files].map(([path, text]) => [relative(path), text])),
      });
    }
  }
  return { probes, loaded, found };
}

describe('loadAliases against TypeScript', () => {
  it(
    'gives, from each project folder, the file TypeScript loads for every module name, or none where it loads none',
    async () => {
      let probes = 0;
      let loaded = 0;
      const found: Disagreement[] = [];
      for (let round = 0; round < ROUNDS; round++) {
        const result = await disagreements(round, generate(seeded(round)));
        probes += result.probes;
        loaded += result.loaded;
        found.push(...result.found);
      }

      // A generator that stopped producing names TypeScript can load would pass on "none".
      expect(loaded).toBeGreaterThan(ROUNDS);
      expect(found.slice(0, 3), `${found.length} of ${probes} paths disagree`).toEqual([]);
    },
    TIMEOUT_MS,
  );
});

/**
 * Keys that begin one another (`@` and `@/components`), one ending in a slash, two ending in a
 * `*`, which Vite matches as written rather than as a wildcard (`@/*`, `lib*`), and two that
 * JavaScript enumerates before the other keys of an object (`1`, `2`) beside one that only
 * starts like them (`1/a`).
 */
const VITE_FINDS = [
  '@',
  '@/',
  '@/*',
  '@/components',
  '@/components/icons',
  '~',
  '@components',
  '#img',
  'lib*',
  '1',
  '1/a',
  '2',
];
const VITE_TARGETS = ['src', 'lib/components', 'shared', 'src/components', 'assets/img'];
const VITE_TAILS = ['', '/', '/x.png', '/components/icon.png', '/icons/a.svg', 'x.png', '//x.png'];

interface ViteEntry {
  readonly find: string;
  readonly target: string;
  /** Whether the replacement ends in `/`, which Vite drops when the key ends in one too. */
  readonly slash: boolean;
}

function viteEntries(random: () => number): ViteEntry[] {
  return Array.from({ length: 1 + Math.floor(random() * 5) }, () => ({
    find: pick(random, VITE_FINDS),
    target: pick(random, VITE_TARGETS),
    slash: random() < 0.3,
  }));
}

/** The config module as Vite's templates write it, its aliases an object or an array. */
function viteConfigText(entries: readonly ViteEntry[], form: 'object' | 'array'): string {
  const value = ({ target, slash }: ViteEntry) =>
    `path.resolve(__dirname, ${JSON.stringify(target)})${slash ? " + '/'" : ''}`;
  const items = entries.map((entry) =>
    form === 'object'
      ? `${JSON.stringify(entry.find)}: ${value(entry)}`
      : `{ find: ${JSON.stringify(entry.find)}, replacement: ${value(entry)} }`,
  );
  const alias = form === 'object' ? `{ ${items.join(', ')} }` : `[${items.join(', ')}]`;
  return `import path from 'node:path';\nexport default { resolve: { alias: ${alias} } };\n`;
}

/** The value that module exports for `resolve.alias`. */
function viteAliasValue(
  entries: readonly ViteEntry[],
  form: 'object' | 'array',
): Record<string, string> | { find: string; replacement: string }[] {
  const replacement = ({ target, slash }: ViteEntry) =>
    `${resolve(ROOT, target)}${slash ? '/' : ''}`;
  if (form === 'array') {
    return entries.map((entry) => ({ find: entry.find, replacement: replacement(entry) }));
  }
  // Assigned in written order, so the keys fall in the order the object literal gives them.
  const object: Record<string, string> = {};
  for (const entry of entries) object[entry.find] = replacement(entry);
  return object;
}

const VITE_CONFIG = `${ROOT}/vite.config.ts`;
const VITE_IMPORTER = `${ROOT}/src/main.ts`;

/** One round: every import drawn from the keys, asked of Upfly and of Vite. */
async function viteRound(round: number): Promise<{
  readonly skipped: readonly unknown[];
  readonly mapped: number;
  readonly found: readonly object[];
}> {
  const random = seeded(round);
  const entries = viteEntries(random);
  const form = random() < 0.5 ? 'object' : 'array';
  const text = viteConfigText(entries, form);
  const map = await loadAliases({
    root: ROOT,
    files: [{ path: VITE_CONFIG, relative: 'vite.config.ts' }],
    readFile: async () => text,
    isFile: (path) => toPosix(path) === VITE_CONFIG,
  });

  const resolved = await resolveConfig(
    {
      configFile: false,
      root: ROOT,
      logLevel: 'silent',
      resolve: { alias: viteAliasValue(entries, form) },
    },
    'build',
  );
  const environment = new BuildEnvironment('client', resolved);
  const resolveId = createIdResolver(resolved);
  const ids = VITE_FINDS.flatMap((find) => VITE_TAILS.map((tail) => `${find}${tail}`));
  let mapped = 0;
  const found: object[] = [];
  for (const id of ids) {
    const vite = await resolveId(environment, id, VITE_IMPORTER, true);
    if (vite !== undefined) mapped += 1;
    const expected = vite === undefined ? [] : [toPosix(resolve(vite))];
    const upfly = expandAlias(map, id, VITE_IMPORTER);
    if (JSON.stringify(upfly) !== JSON.stringify(expected)) {
      found.push({ round, id, vite: expected, upfly, config: text });
    }
  }
  return { skipped: map.skipped, mapped, found };
}

describe('loadAliases against Vite', () => {
  it(
    'gives the path Vite rewrites each import to, and no candidate where no Vite alias matches',
    async () => {
      let mapped = 0;
      const found: object[] = [];
      for (let round = 0; round < ROUNDS; round++) {
        const result = await viteRound(round);
        expect(result.skipped).toEqual([]);
        mapped += result.mapped;
        found.push(...result.found);
      }
      const probes = ROUNDS * VITE_FINDS.length * VITE_TAILS.length;

      // A generator that stopped producing mapped paths would pass with nothing checked.
      expect(mapped).toBeGreaterThan(ROUNDS);
      expect(found.slice(0, 3), `${found.length} of ${probes} paths disagree`).toEqual([]);
    },
    TIMEOUT_MS,
  );
});
