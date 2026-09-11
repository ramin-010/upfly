import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type AliasMap, expandAlias, loadAliases } from './aliases.js';
import { toPosix } from './paths.js';

const ROOT = resolve('/project');

/** A fake filesystem: path -> contents. Absent means "does not exist". */
function fs(files: Record<string, string>) {
  const byPosix = new Map(
    Object.entries(files).map(([key, value]) => [toPosix(resolve(ROOT, key)), value]),
  );
  return {
    files: [...byPosix.keys()].map((posix) => ({
      path: posix,
      relative: posix.slice(toPosix(ROOT).length + 1),
    })),
    readFile: async (path: string) => {
      const text = byPosix.get(toPosix(path));
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    },
    exists: (path: string) => byPosix.has(toPosix(path)),
  };
}

async function load(files: Record<string, string>): Promise<AliasMap> {
  const { files: list, readFile, exists } = fs(files);
  return loadAliases({ root: ROOT, files: list, readFile, exists });
}

const from = (relative: string) => toPosix(resolve(ROOT, relative));

describe('loadAliases — tsconfig', () => {
  it('reads a wildcard mapping and expands it to an absolute path', async () => {
    const map = await load({
      'tsconfig.json': '{ "compilerOptions": { "paths": { "~/*": ["./src/*"] } } }',
    });

    // Written out rather than pasted: `~/assets/x.png` under `~/* -> ./src/*` is
    // `<root>/src/assets/x.png`.
    expect(expandAlias(map, '~/assets/x.png', from('src/pages/a.astro'))).toEqual([
      from('src/assets/x.png'),
    ]);
  });

  it('parses JSONC — comments and trailing commas — rather than throwing on them', async () => {
    // `shadcn-ui/apps/v4/tsconfig.json` carries a four-line comment inside `paths`.
    // `JSON.parse` throws on this input; the whole point is that this does not.
    const map = await load({
      'tsconfig.json': `{
        // a leading comment
        "compilerOptions": {
          "baseUrl": ".",
          "paths": {
            /* the real mapping */
            "@/*": ["./app/*"],
          },
        },
      }`,
    });

    expect(map.skipped).toEqual([]);
    expect(expandAlias(map, '@/img/x.png', from('app/page.tsx'))).toEqual([from('app/img/x.png')]);
  });

  it('honours baseUrl when the targets are written relative to it', async () => {
    const map = await load({
      'apps/web/tsconfig.json':
        '{ "compilerOptions": { "baseUrl": "./src", "paths": { "@/*": ["./lib/*"] } } }',
    });

    expect(expandAlias(map, '@/x.png', from('apps/web/src/a.tsx'))).toEqual([
      from('apps/web/src/lib/x.png'),
    ]);
  });

  it('prefers the longer prefix when two mappings both match', async () => {
    const map = await load({
      'tsconfig.json': `{ "compilerOptions": { "paths": {
        "@/*": ["./everything/*"],
        "@/app/*": ["./real-app/*"]
      } } }`,
    });

    // Longest first: `@/app/x.png` must reach `real-app`, and `everything` only after.
    expect(expandAlias(map, '@/app/x.png', from('a.tsx'))[0]).toBe(from('real-app/x.png'));
  });

  it('follows a relative extends chain', async () => {
    const map = await load({
      'tsconfig.base.json': '{ "compilerOptions": { "paths": { "~/*": ["./shared/*"] } } }',
      'packages/ui/tsconfig.json': '{ "extends": "../../tsconfig.base.json" }',
    });

    // The inherited rule is anchored at the BASE config's directory, which is what
    // TypeScript does, so `~/x.png` from the package reaches the root's `shared/`.
    expect(expandAlias(map, '~/x.png', from('packages/ui/a.ts'))).toContain(from('shared/x.png'));
  });

  it('follows an extends into node_modules by name, without walking it', async () => {
    // R33: the prune is a property of the asset graph, not a filesystem ban. Note the
    // config inside node_modules is NOT in the `files` list — only the explicit
    // `extends` target makes it reachable, which is the distinction being tested.
    const { readFile, exists } = fs({
      'tsconfig.json': '{ "extends": "astro/tsconfigs/strict" }',
      'node_modules/astro/tsconfigs/strict.json':
        '{ "compilerOptions": { "paths": { "~/*": ["./src/*"] } } }',
    });
    const map = await loadAliases({
      root: ROOT,
      files: [{ path: from('tsconfig.json'), relative: 'tsconfig.json' }],
      readFile,
      exists,
    });

    expect(map.rules).toHaveLength(1);
    expect(map.rules[0]?.source).toContain('strict.json');
  });

  it('reports an extends it cannot find instead of dropping it', async () => {
    const map = await load({ 'tsconfig.json': '{ "extends": "./nowhere.json" }' });

    expect(map.skipped).toEqual([
      { what: 'tsconfig.json', reason: expect.stringContaining('could not be found') },
    ]);
  });

  it('does not hang on a circular extends', async () => {
    const map = await load({
      'a.json': '{ "extends": "./b.json", "compilerOptions": { "paths": { "@/*": ["./x/*"] } } }',
      'tsconfig.json': '{ "extends": "./a.json" }',
      'b.json': '{ "extends": "./a.json" }',
    });

    expect(map.rules.map((rule) => rule.prefix)).toEqual(['@/']);
  });

  it('reports a config it cannot parse rather than reading nothing quietly', async () => {
    const map = await load({ 'tsconfig.json': '{ "compilerOptions": { not json at all' });

    expect(map.rules).toEqual([]);
    expect(map.skipped[0]?.reason).toContain('could not be parsed');
  });
});

describe('loadAliases — Vite', () => {
  it('reads a string-literal alias as a PREFIX replacement, not an exact match', async () => {
    // Vite and tsconfig mean different things by a key. A tsconfig `paths` key is a
    // pattern where `*` says "prefix"; a Vite string key is *always* a prefix
    // replacement, so `{'@': './src'}` turns `@/x.png` into `./src/x.png`. Treating
    // it as an exact match would silently resolve nothing at all.
    const map = await load({
      'vite.config.ts': '{ resolve: { alias: { "@": "./src" } } }',
    });

    expect(expandAlias(map, '@/x.png', from('a.tsx'))).toEqual([from('src/x.png')]);
  });

  it('🔴 refuses to evaluate a computed alias, and says so with a line (R33)', async () => {
    // Every `resolve.alias` in the validation corpus is exactly this shape. Executing
    // it would mean running a config file from a repository the user did not write.
    const map = await load({
      'vite.config.ts': `{
        resolve: {
          alias: {
            "@": path.resolve(__dirname, "./src")
          }
        }
      }`,
    });

    expect(map.rules).toEqual([]);
    expect(map.skipped[0]?.what).toBe('vite.config.ts');
    expect(map.skipped[0]?.reason).toContain('computed');
    expect(map.skipped[0]?.reason).toContain('line 4');
  });

  it('reports a real module-shaped config rather than pretending it had no aliases', async () => {
    // The ordinary case: a config that is a module, not a bare object. Finding the
    // alias object inside it means evaluating `defineConfig`, which is the line this
    // module does not cross — so it is reported, not silently skipped (rule 9).
    const map = await load({
      'vite.config.ts': [
        'import { defineConfig } from "vite";',
        'export default defineConfig({ resolve: { alias: { "@": "./src" } } });',
      ].join('\n'),
    });

    expect(map.rules).toEqual([]);
    expect(map.skipped[0]?.reason).toMatch(/executable JavaScript|statically/);
  });
});

describe('expandAlias — scope', () => {
  it('does not apply a package-local alias to a file outside that package', async () => {
    const map = await load({
      'packages/ui/tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }',
    });

    expect(expandAlias(map, '@/x.png', from('packages/ui/a.tsx'))).toEqual([
      from('packages/ui/src/x.png'),
    ]);
    // The control. shadcn-ui has ~20 configs all defining `@/*`; without scoping,
    // every one of them would offer a candidate for every reference in the repo.
    expect(expandAlias(map, '@/x.png', from('apps/web/a.tsx'))).toEqual([]);
  });

  it('returns nothing when no rule matches, so the caller keeps unresolved-alias', async () => {
    const map = await load({
      'tsconfig.json': '{ "compilerOptions": { "paths": { "~/*": ["./src/*"] } } }',
    });

    expect(expandAlias(map, '@/other.png', from('a.tsx'))).toEqual([]);
  });
});
