import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readViteAliases } from './vite-config.js';

/**
 * Each text is a whole config module. The folder is the config's, so `__dirname`,
 * `import.meta.url` and a root-relative `/src` all land under it.
 */
const FOLDER = resolve('/project/app');
const read = (lines: readonly string[], name = 'vite.config.ts') =>
  readViteAliases(lines.join('\n'), join(FOLDER, name));
const at = (relative: string) => join(FOLDER, relative);

describe('readViteAliases reads what Vite computes from the config location', () => {
  it.each([
    [
      'create-vue: fileURLToPath of a URL against import.meta.url',
      [
        "import { fileURLToPath, URL } from 'node:url'",
        "import { defineConfig } from 'vite'",
        'export default defineConfig({',
        "  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },",
        '})',
      ],
      'vite.config.js',
    ],
    [
      'the ESM __dirname const, and satisfies',
      [
        "import path from 'node:path'",
        "import { fileURLToPath } from 'node:url'",
        "import type { UserConfig } from 'vite'",
        'const __dirname = path.dirname(fileURLToPath(import.meta.url))',
        "export default { resolve: { alias: { '@': path.resolve(__dirname, 'src') } } } satisfies UserConfig",
      ],
      'vite.config.ts',
    ],
    [
      'a CommonJS config',
      [
        "const path = require('path')",
        "module.exports = { resolve: { alias: { '@': path.join(__dirname, 'src') } } }",
      ],
      'vite.config.cjs',
    ],
    [
      'a function config',
      [
        "import { resolve } from 'node:path'",
        "import { defineConfig as define } from 'vite'",
        "export default define(({ mode }) => ({ resolve: { alias: { '@': resolve(__dirname, 'src') } } }))",
      ],
      'vite.config.ts',
    ],
    [
      'a config held in a const, as an array entry',
      [
        "import path from 'node:path'",
        "const config = { resolve: { alias: [{ find: '@', replacement: path.resolve(__dirname, 'src') }] } }",
        'export default config',
      ],
      'vite.config.ts',
    ],
  ] as const)('%s', (_shape, lines, name) => {
    expect(read(lines, name)).toEqual({
      entries: [{ find: '@', target: at('src'), line: expect.any(Number) }],
      unread: [],
      root: FOLDER,
    });
  });

  it('reads a root-relative string from the Vite root', () => {
    expect(
      read(["export default { resolve: { alias: { '@': '/src' } } }"]).entries[0]?.target,
    ).toBe(at('src'));
    expect(
      read(["export default { root: 'site', resolve: { alias: { '@': '/src' } } }"]).entries[0]
        ?.target,
    ).toBe(at('site/src'));
  });

  it('drops a trailing slash only when the key and the path both have one', () => {
    expect(read(["export default { resolve: { alias: { '@/': '/src/' } } }"]).entries).toEqual([
      { find: '@', target: at('src'), line: 1 },
    ]);
  });

  it('reads an alias object in the order JavaScript gives its keys, which is the order Vite tries', () => {
    const { entries } = read([
      'export default { resolve: { alias: {',
      "  '1/a': '/a',",
      "  '@': '/first',",
      "  '1': '/one',",
      "  '@': '/last',",
      '} } }',
    ]);

    // Keys that are array indices come first, and a repeated key keeps its first place and
    // its last value.
    expect(entries).toEqual([
      { find: '1', target: at('one'), line: 4 },
      { find: '1/a', target: at('a'), line: 2 },
      { find: '@', target: at('last'), line: 5 },
    ]);
  });

  it('reads nothing, and reports nothing, from a config with no alias', () => {
    expect(
      read([
        "import { defineConfig } from 'vite'",
        'const config = defineConfig({ resolve: { tsconfigPaths: true } })',
        'export default config',
      ]),
    ).toEqual({ entries: [], unread: [], root: FOLDER });
  });
});

describe('readViteAliases reports what it would have to run, with its line', () => {
  it.each([
    [
      'a path relative to each importing file',
      ["export default { resolve: { alias: { '@': './src' } } }"],
      'relative to each importing file',
    ],
    [
      'a path.resolve with no absolute part',
      [
        "import path from 'node:path'",
        "export default { resolve: { alias: { '@': path.resolve('src') } } }",
      ],
      'depends on the folder Vite runs in',
    ],
    [
      'process.cwd()',
      [
        "import path from 'node:path'",
        "export default { resolve: { alias: { '@': path.join(process.cwd(), 'src') } } }",
      ],
      'depends on the folder Vite runs in',
    ],
    [
      'a name bound twice',
      [
        "import path from 'node:path'",
        "const helper = () => { const path = { resolve: () => '/x' }; return path }",
        "export default { resolve: { alias: { '@': path.resolve(__dirname, 'src') } } }",
      ],
      'code Upfly does not run',
    ],
    [
      'a function call off the list',
      ["export default { resolve: { alias: { '@': locate('src') } } }"],
      'code Upfly does not run',
    ],
    [
      'a regular expression key',
      ["export default { resolve: { alias: [{ find: /^~(.*)$/, replacement: '$1' }] } }"],
      'finds by a pattern',
    ],
    [
      'a customResolver',
      [
        "export default { resolve: { alias: [{ find: '@', replacement: '/src', customResolver: resolver }] } }",
      ],
      'customResolver',
    ],
    [
      'a spread after the alias',
      ["export default { resolve: { alias: { '@': '/src' }, ...extra } }"],
      'may replace alias',
    ],
  ] as const)('%s', (_shape, lines, why) => {
    const { entries, unread } = read(lines);

    expect(entries).toEqual([]);
    expect(unread).toHaveLength(1);
    expect(unread[0]?.line).toBe(lines.length);
    expect(unread[0]?.reason).toContain(why);
  });

  it('reports a config that does not parse, in one fixed sentence', () => {
    expect(read(['export default {']).unread).toEqual([
      { line: null, reason: 'could not be parsed, so its aliases were not read' },
    ]);
  });
});
