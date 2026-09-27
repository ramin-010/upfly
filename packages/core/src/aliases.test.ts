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
    isFile: (path: string) => byPosix.has(toPosix(path)),
  };
}

/** `hidden` files can be read but were not discovered, as in a folder `discover` prunes. */
async function load(
  files: Record<string, string>,
  hidden: readonly string[] = [],
): Promise<AliasMap> {
  const { files: list, readFile, isFile } = fs(files);
  const unseen = new Set(hidden.map((relative) => toPosix(resolve(ROOT, relative))));
  const discovered = list.filter((file) => !unseen.has(file.path));
  return loadAliases({ root: ROOT, files: discovered, readFile, isFile });
}

const from = (relative: string) => toPosix(resolve(ROOT, relative));

describe('loadAliases: tsconfig', () => {
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

  it('parses JSONC, comments and trailing commas included, rather than throwing on them', async () => {
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

  it('takes an exact key before a pattern of the same length, as TypeScript does', async () => {
    const map = await load({
      'tsconfig.json':
        '{ "compilerOptions": { "paths": { "@*": ["./star/*"], "@": ["./exact"] } } }',
    });

    expect(expandAlias(map, '@', from('a.ts'))).toEqual([from('exact'), from('star')]);
  });

  it('follows a relative extends chain', async () => {
    const map = await load({
      'tsconfig.base.json': '{ "compilerOptions": { "paths": { "~/*": ["./shared/*"] } } }',
      'packages/ui/tsconfig.json': '{ "extends": "../../tsconfig.base.json" }',
    });

    // The rule serves the package, and its targets are read from the base that wrote them,
    // as TypeScript reads them, so `~/x.png` from the package reaches the root's `shared/`.
    expect(expandAlias(map, '~/x.png', from('packages/ui/a.ts'))).toContain(from('shared/x.png'));
  });

  it('follows an extends into node_modules by name, without walking it', async () => {
    // Pruning `node_modules` keeps it out of the asset graph; it does not forbid reading
    // it. The config there is not in the `files` list, so only the explicit `extends`
    // makes it reachable, which is what this tests.
    const { readFile, isFile } = fs({
      'tsconfig.json': '{ "extends": "astro/tsconfigs/strict" }',
      'node_modules/astro/tsconfigs/strict.json':
        '{ "compilerOptions": { "paths": { "~/*": ["./src/*"] } } }',
    });
    const map = await loadAliases({
      root: ROOT,
      files: [{ path: from('tsconfig.json'), relative: 'tsconfig.json' }],
      readFile,
      isFile,
    });

    expect(map.rules).toHaveLength(1);
    expect(map.rules[0]?.source).toContain('strict.json');
    expect(expandAlias(map, '~/x.png', from('src/pages/a.astro'))).toEqual([
      from('node_modules/astro/tsconfigs/src/x.png'),
    ]);
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
    expect(map.skipped).toEqual([
      { what: 'tsconfig.json', reason: 'could not be parsed, so its aliases were not read' },
    ]);
  });

  it('says a config could not be read by its error code alone, never the path', async () => {
    const error = Object.assign(
      new Error(`EACCES: permission denied, open '${from('tsconfig.json')}'`),
      {
        code: 'EACCES',
      },
    );
    const map = await loadAliases({
      root: ROOT,
      files: [{ path: from('tsconfig.json'), relative: 'tsconfig.json' }],
      readFile: async () => {
        throw error;
      },
      isFile: () => true,
    });

    expect(map.skipped).toEqual([
      { what: 'tsconfig.json', reason: 'could not be read (EACCES), so its aliases were not read' },
    ]);
  });
});

/**
 * TypeScript applies the `paths` a config inherits to the project that extends it. The
 * targets are read against a `baseUrl` from any config in the chain, else against the
 * folder of the config that wrote them, and a `paths` later in the chain replaces an earlier
 * one whole.
 */
describe('loadAliases: an inherited paths', () => {
  it('serves a SvelteKit app from the config svelte-kit sync generates', async () => {
    const map = await load(
      {
        'sites/kit/tsconfig.json': '{ "extends": "./.svelte-kit/tsconfig.json" }',
        'sites/kit/.svelte-kit/tsconfig.json':
          '{ "compilerOptions": { "paths": { "$lib": ["../src/lib"], "$lib/*": ["../src/lib/*"] } } }',
      },
      ['sites/kit/.svelte-kit/tsconfig.json'],
    );

    expect(expandAlias(map, '$lib/assets/x.png', from('sites/kit/src/routes/+page.ts'))).toEqual([
      from('sites/kit/src/lib/assets/x.png'),
    ]);
  });

  it.each([
    ['3.0', '{ "compilerOptions": { "baseUrl": "..", "paths": { "~": ["."], "~/*": ["./*"] } } }'],
    ['3.13', '{ "compilerOptions": { "paths": { "~": [".."], "~/*": ["../*"] } } }'],
  ])('serves a Nuxt %s app from the config Nuxt generates', async (_version, generated) => {
    const map = await load(
      {
        'sites/nuxt/tsconfig.json': '{ "extends": "./.nuxt/tsconfig.json" }',
        'sites/nuxt/.nuxt/tsconfig.json': generated,
      },
      ['sites/nuxt/.nuxt/tsconfig.json'],
    );

    expect(expandAlias(map, '~/assets/x.png', from('sites/nuxt/composables/useHero.ts'))).toEqual([
      from('sites/nuxt/assets/x.png'),
    ]);
  });

  it('reads configDir in a shared base as the folder of the config that extends it', async () => {
    const map = await load(
      {
        'apps/web/tsconfig.json': '{ "extends": "@acme/tsconfig/base.json" }',
        'node_modules/@acme/tsconfig/base.json':
          '{ "compilerOptions": { "paths": { "@/*": ["${configDir}/src/*"] } } }',
      },
      ['node_modules/@acme/tsconfig/base.json'],
    );

    expect(expandAlias(map, '@/x.png', from('apps/web/a.tsx'))).toEqual([
      from('apps/web/src/x.png'),
    ]);
  });

  it('reads an inherited target against the baseUrl of the config that extends it', async () => {
    const map = await load({
      'configs/base.json': '{ "compilerOptions": { "paths": { "@/*": ["*"] } } }',
      'apps/web/tsconfig.json':
        '{ "extends": "../../configs/base.json", "compilerOptions": { "baseUrl": "./src" } }',
    });

    expect(expandAlias(map, '@/x.png', from('apps/web/a.tsx'))).toEqual([
      from('apps/web/src/x.png'),
    ]);
  });

  it('reads a baseUrl against the config that declares it, for the paths its extender writes', async () => {
    const map = await load({
      'configs/base.json': '{ "compilerOptions": { "baseUrl": "../shared" } }',
      'apps/web/tsconfig.json':
        '{ "extends": "../../configs/base.json", "compilerOptions": { "paths": { "@/*": ["./lib/*"] } } }',
    });

    expect(expandAlias(map, '@/x.png', from('apps/web/a.tsx'))).toEqual([from('shared/lib/x.png')]);
  });

  it('lets the paths a project writes replace the one it inherits, whole', async () => {
    const map = await load({
      'tsconfig.base.json': '{ "compilerOptions": { "paths": { "@/*": ["./inherited/*"] } } }',
      'tsconfig.json':
        '{ "extends": "./tsconfig.base.json", "compilerOptions": { "paths": { "@/*": ["./local/*"] } } }',
    });

    expect(expandAlias(map, '@/x.png', from('a.tsx'))).toEqual([from('local/x.png')]);
  });

  it('takes the last paths an extends list gives, and keeps it past a base with none', async () => {
    const map = await load({
      'bases/a.json': '{ "compilerOptions": { "paths": { "@/*": ["./a/*"] } } }',
      'bases/b.json': '{ "compilerOptions": { "paths": { "@/*": ["./b/*"] } } }',
      'bases/c.json': '{ "compilerOptions": { "strict": true } }',
      'one/tsconfig.json': '{ "extends": ["../bases/a.json", "../bases/b.json"] }',
      'two/tsconfig.json': '{ "extends": ["../bases/a.json", "../bases/c.json"] }',
    });

    expect(expandAlias(map, '@/x.png', from('one/main.ts'))).toEqual([from('bases/b/x.png')]);
    expect(expandAlias(map, '@/x.png', from('two/main.ts'))).toEqual([from('bases/a/x.png')]);
  });

  it('lets a shared base serve only the projects that extend it', async () => {
    const map = await load({
      'tsconfig.base.json': '{ "compilerOptions": { "paths": { "~/*": ["./shared/*"] } } }',
      'packages/ui/tsconfig.json': '{ "extends": "../../tsconfig.base.json" }',
    });

    expect(expandAlias(map, '~/x.png', from('packages/ui/a.ts'))).toEqual([from('shared/x.png')]);
    expect(expandAlias(map, '~/x.png', from('apps/web/a.ts'))).toEqual([]);
  });
});

/**
 * An `extends` names the file TypeScript would load. A relative or rooted path names a file,
 * `.json` added when missing; anything else is a package in `node_modules`.
 */
describe('loadAliases: finding an extends', () => {
  const PATHS = '{ "compilerOptions": { "paths": { "@/*": ["${configDir}/src/*"] } } }';

  it.each([
    [
      'the tsconfig field of its package.json',
      '@acme/cfg',
      {
        'node_modules/@acme/cfg/package.json': '{ "tsconfig": "./configs/base.json" }',
        'node_modules/@acme/cfg/configs/base.json': PATHS,
      },
    ],
    ['its tsconfig.json', '@tsconfig/x', { 'node_modules/@tsconfig/x/tsconfig.json': PATHS }],
    [
      'the tsconfig.json of a folder inside it',
      '@acme/cfg/react',
      { 'node_modules/@acme/cfg/react/tsconfig.json': PATHS },
    ],
  ])('finds a package through %s', async (_how, target, installed) => {
    const map = await load(
      { 'tsconfig.json': `{ "extends": "${target}" }`, ...installed },
      Object.keys(installed),
    );

    expect(map.skipped).toEqual([]);
    expect(expandAlias(map, '@/x.png', from('a.ts'))).toEqual([from('src/x.png')]);
  });

  it('reads a path with no ./ as a package, as TypeScript does', async () => {
    const map = await load(
      {
        'tsconfig.json': '{ "extends": ".nuxt/tsconfig.json" }',
        '.nuxt/tsconfig.json': '{ "compilerOptions": { "paths": { "~/*": ["../*"] } } }',
      },
      ['.nuxt/tsconfig.json'],
    );

    expect(map.rules).toEqual([]);
    expect(map.skipped).toEqual([
      { what: 'tsconfig.json', reason: expect.stringContaining('could not be found') },
    ]);
  });
});

describe('loadAliases: Vite', () => {
  it('reads a key as the whole path or before a slash, from the Vite root', async () => {
    const map = await load({
      'vite.config.ts': "export default { resolve: { alias: { '@': '/src' } } };\n",
    });

    expect(expandAlias(map, '@/x.png', from('a.tsx'))).toEqual([from('src/x.png')]);
    expect(expandAlias(map, '@', from('a.tsx'))).toEqual([from('src')]);
    // A key is not a bare prefix: `@img/x.png` is another alias, which this one does not map.
    expect(expandAlias(map, '@img/x.png', from('a.tsx'))).toEqual([]);
  });

  it('reads a real config module, as Vite templates write it', async () => {
    const map = await load({
      'apps/web/vite.config.ts': [
        'import path from "path"',
        'import { defineConfig } from "vite"',
        '',
        'export default defineConfig({',
        '  resolve: {',
        '    alias: {',
        '      "@": path.resolve(__dirname, "./src"),',
        '    },',
        '  },',
        '})',
        '',
      ].join('\n'),
    });

    expect(map.skipped).toEqual([]);
    expect(expandAlias(map, '@/x.png', from('apps/web/src/a.tsx'))).toEqual([
      from('apps/web/src/x.png'),
    ]);
  });

  it('refuses an alias that depends on the folder Vite runs in, and says so with a line', async () => {
    const map = await load({
      'vite.config.ts': [
        "import path from 'node:path';",
        'export default {',
        '  resolve: {',
        '    alias: {',
        "      '@': path.resolve(process.cwd(), 'src'),",
        '    },',
        '  },',
        '};',
        '',
      ].join('\n'),
    });

    expect(map.rules).toEqual([]);
    expect(map.skipped).toEqual([
      {
        what: 'vite.config.ts',
        reason: 'the alias "@" at line 5 depends on the folder Vite runs in, so it was not read',
      },
    ]);
  });
});

describe('expandAlias: scope', () => {
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

  it("lets the nearest config answer before a parent config's longer key", async () => {
    const map = await load({
      'tsconfig.json':
        '{ "compilerOptions": { "paths": { "@/components/*": ["./shared/components/*"] } } }',
      'apps/web/tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }',
    });

    // TypeScript reads only the nearest config, so the app's own `@/*` answers; the root's
    // longer key stays behind it as a fallback.
    expect(expandAlias(map, '@/components/x.png', from('apps/web/src/a.ts'))).toEqual([
      from('apps/web/src/components/x.png'),
      from('shared/components/x.png'),
    ]);
  });

  it("lets an app's own Vite alias answer before a parent config's longer key", async () => {
    const map = await load({
      'tsconfig.json':
        '{ "compilerOptions": { "paths": { "@/components/*": ["./shared/components/*"] } } }',
      'apps/web/vite.config.ts': [
        "import path from 'node:path';",
        "export default { resolve: { alias: { '@': path.resolve(__dirname, './src') } } };",
        '',
      ].join('\n'),
    });

    expect(expandAlias(map, '@/components/x.png', from('apps/web/src/a.ts'))[0]).toBe(
      from('apps/web/src/components/x.png'),
    );
  });

  it('returns nothing when no rule matches, so the caller keeps unresolved-alias', async () => {
    const map = await load({
      'tsconfig.json': '{ "compilerOptions": { "paths": { "~/*": ["./src/*"] } } }',
    });

    expect(expandAlias(map, '@/other.png', from('a.tsx'))).toEqual([]);
  });
});
