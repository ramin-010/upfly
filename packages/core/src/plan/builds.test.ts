import { describe, expect, it } from 'vitest';
import { type Build, buildOf, detectBuilds } from './builds.js';

/** The build of `file` in a project holding these files, with each `package.json`'s text. */
async function buildFor(file: string, tree: Readonly<Record<string, string>>): Promise<Build> {
  const builds = await detectBuilds({
    files: Object.keys(tree).map((relative) => ({ path: `/repo/${relative}`, relative })),
    readFile: async (path) => {
      const text = tree[path.slice('/repo/'.length)];
      if (text === undefined) throw new Error(`no such file: ${path}`);
      return text;
    },
  });
  return buildOf(builds, file);
}

const manifest = (build?: string) =>
  JSON.stringify(build === undefined ? { private: true } : { scripts: { build } });

describe('the build a settings file names', () => {
  it.each([
    ['vite.config.ts', 'Vite'],
    ['vite.config.mjs', 'Vite'],
    ['next.config.mjs', 'Next.js'],
    ['next.config.ts', 'Next.js'],
    ['astro.config.mjs', 'Astro'],
    ['astro.config.ts', 'Astro'],
  ] as const)('knows %s as %s', async (settings, name) => {
    expect(
      await buildFor('src/App.jsx', {
        'package.json': manifest(),
        [settings]: '',
        'src/App.jsx': '',
      }),
    ).toEqual({ kind: 'known', name });
  });

  it.each([
    'webpack.config.js',
    'webpack.prod.js',
    'webpack.config.babel.js',
    'rollup.config.mjs',
    'vue.config.js',
    'gatsby-config.ts',
    '.parcelrc',
    'angular.json',
  ])('names %s as a build Upfly cannot vouch for', async (settings) => {
    expect(
      await buildFor('src/App.jsx', {
        'package.json': manifest(),
        [settings]: '',
        'src/App.jsx': '',
      }),
    ).toEqual({ kind: 'other', file: settings });
  });

  it('lets another build outweigh a known one in the same package', async () => {
    // Which of the two loads a file cannot be told from outside, so neither vouches for it.
    expect(
      await buildFor('src/App.jsx', {
        'package.json': manifest('vite build'),
        'vite.config.ts': '',
        'webpack.config.js': '',
        'src/App.jsx': '',
      }),
    ).toEqual({ kind: 'other', file: 'webpack.config.js' });
  });
});

describe('the build a build script names', () => {
  it.each([
    ['vite build', 'Vite'],
    ['tsc && vite build', 'Vite'],
    ['pnpm exec vite build --mode production', 'Vite'],
    ['contentlayer2 build && next build', 'Next.js'],
    ['astro check && astro build', 'Astro'],
  ] as const)('knows `%s` as %s', async (script, name) => {
    expect(
      await buildFor('src/App.jsx', { 'package.json': manifest(script), 'src/App.jsx': '' }),
    ).toEqual({ kind: 'known', name });
  });

  it.each([
    ['npm run clean && NODE_OPTIONS=--max_old_space_size=8000 webpack --bail', 'webpack --bail'],
    ['cross-env NODE_ENV=production rollup -c', 'rollup -c'],
    ['react-scripts build', 'react-scripts build'],
    ['tsup src/index.ts', 'tsup src/index.ts'],
  ])('names the command of `%s`', async (script, command) => {
    expect(
      await buildFor('src/App.jsx', { 'package.json': manifest(script), 'src/App.jsx': '' }),
    ).toEqual({ kind: 'other', file: 'package.json', command });
  });

  it.each(['npm run build:css', 'turbo run build', 'eleventy', 'vite'])(
    'finds no build in `%s`, which names none it can recognise',
    async (script) => {
      expect(
        await buildFor('src/App.jsx', { 'package.json': manifest(script), 'src/App.jsx': '' }),
      ).toEqual({ kind: 'none' });
    },
  );

  it('still reads the settings files when the manifest is not JSON', async () => {
    expect(
      await buildFor('src/App.jsx', {
        'package.json': '{ not json',
        'next.config.js': '',
        'src/App.jsx': '',
      }),
    ).toEqual({ kind: 'known', name: 'Next.js' });
  });
});

describe('which package a file belongs to', () => {
  const MONOREPO = {
    'package.json': manifest('turbo run build'),
    'vite.config.ts': '',
    'apps/web/package.json': manifest('next build'),
    'apps/web/app/page.tsx': '',
    'packages/ui/package.json': manifest('tsc'),
    'packages/ui/src/Button.tsx': '',
    'tools/scripts/run.js': '',
  };

  it('is the nearest folder holding a package.json', async () => {
    expect(await buildFor('apps/web/app/page.tsx', MONOREPO)).toEqual({
      kind: 'known',
      name: 'Next.js',
    });
  });

  it('takes no settings from a folder above its own package', async () => {
    // The root's vite.config builds the root package, not a package with a manifest of its own.
    expect(await buildFor('packages/ui/src/Button.tsx', MONOREPO)).toEqual({ kind: 'none' });
  });

  it('falls back to the nearest package above when its own folder has none', async () => {
    expect(await buildFor('tools/scripts/run.js', MONOREPO)).toEqual({
      kind: 'known',
      name: 'Vite',
    });
  });

  it('has no build when no package.json holds it', async () => {
    expect(await buildFor('src/App.jsx', { 'vite.config.ts': '', 'src/App.jsx': '' })).toEqual({
      kind: 'none',
    });
  });

  it('does not take a folder whose name only starts the same for its parent', async () => {
    expect(
      await buildFor('apps/website/x.js', {
        'apps/web/package.json': manifest('next build'),
        'apps/website/x.js': '',
      }),
    ).toEqual({ kind: 'none' });
  });
});
