/**
 * `loadAliases` and `expandAlias` against TypeScript's own module resolution, over configs
 * drawn at random: `extends` chains (arrays, cycles, packages), `baseUrl`, `${configDir}` and
 * nested projects. TypeScript is asked through its public API and sees a file at every
 * `probe.ts` and `lib.ts`, so it answers with its own first candidate, whatever Upfly computed.
 */

import { posix, resolve } from 'node:path';
import ts from 'typescript';
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
const KEYS = ['@/*', '~/*', '#lib/*', '@/components/*', '$lib', '$lib/*'];
const PATTERN_TARGETS = ['./src/*', 'src/*', '../shared/*', '*', '${configDir}/lib/*', './gen/*'];
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
    paths[key] = key.endsWith('*')
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
  const probe = /\/(probe|lib)\.ts$/;
  return {
    useCaseSensitiveFileNames: true,
    getCurrentDirectory: () => ROOT,
    readDirectory: () => [],
    directoryExists: () => true,
    fileExists: (path) => files.has(toPosix(path)) || probe.test(toPosix(path)),
    readFile: (path) =>
      files.get(toPosix(path)) ?? (probe.test(toPosix(path)) ? 'export {};' : undefined),
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

/** Every specifier some project maps, asked from every project folder whose own `paths` maps it. */
async function disagreements(
  round: number,
  files: ReadonlyMap<string, string>,
): Promise<{ readonly probes: number; readonly found: readonly Disagreement[] }> {
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
  const specifiers = new Set(
    projects.flatMap(({ options }) =>
      Object.keys(options.paths ?? {}).map((key) =>
        key.endsWith('*') ? `${key.slice(0, -1)}probe` : key,
      ),
    ),
  );

  let probes = 0;
  const found: Disagreement[] = [];
  for (const { folder, options } of projects) {
    const keys = Object.keys(options.paths ?? {});
    const from = `${folder}/main.ts`;
    for (const specifier of specifiers) {
      // Only where TypeScript uses `paths`: past them it looks in `node_modules`, and Upfly
      // in a parent folder's config, which is a different question.
      const mapped = keys.some((key) =>
        key.endsWith('*') ? specifier.startsWith(key.slice(0, -1)) : specifier === key,
      );
      if (!mapped) continue;
      probes += 1;

      const resolved = ts.resolveModuleName(specifier, from, options, host).resolvedModule;
      const first = expandAlias(map, specifier, from)[0];
      const typescript =
        resolved === undefined ? '(unresolved)' : relative(resolved.resolvedFileName);
      const upfly = first === undefined ? '(no candidate)' : relative(`${first}.ts`);
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
  return { probes, found };
}

describe('loadAliases against TypeScript', () => {
  it(
    'gives, from each project folder, the file TypeScript resolves for every path its nearest config maps',
    async () => {
      let probes = 0;
      const found: Disagreement[] = [];
      for (let round = 0; round < ROUNDS; round++) {
        const result = await disagreements(round, generate(seeded(round)));
        probes += result.probes;
        found.push(...result.found);
      }

      // A generator that stopped producing mapped paths would pass with nothing checked.
      expect(probes).toBeGreaterThan(ROUNDS);
      expect(found.slice(0, 3), `${found.length} of ${probes} paths disagree`).toEqual([]);
    },
    TIMEOUT_MS,
  );
});
