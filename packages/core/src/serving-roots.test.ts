import { describe, expect, it } from 'vitest';
import {
  CONVENTIONAL_SERVING_ROOT_NAMES,
  PROJECT_MARKERS,
  type WalkedTree,
  detectServingRoots,
} from './serving-roots.js';
import type { UnscannedFile } from './types.js';

/**
 * The twelve `public/` directories in shadcn-ui, which is the repository R49 is about.
 *
 * Copied from the validation corpus rather than from memory, and confirmed against a
 * live run: `pnpm --filter upfly-bench run detect-roots` reports 12 hand-tuned, 12
 * detected, 0 missed, 0 extra. An earlier version of this list carried
 * `apps/www/public`, which is not one of them at the pinned commit.
 */
const SHADCN_PUBLIC_DIRS = [
  'apps/v4/public',
  'packages/shadcn/test/fixtures/frameworks/remix-indie-stack/public',
  'packages/shadcn/test/fixtures/frameworks/remix/public',
  'packages/shadcn/test/fixtures/frameworks/vite/public',
  'packages/shadcn/test/fixtures/vite-with-tailwind/public',
  'templates/astro-app/public',
  'templates/astro-monorepo/apps/web/public',
  'templates/next-app/public',
  'templates/react-router-app/public',
  'templates/start-app/public',
  'templates/start-monorepo/apps/web/public',
  'templates/vite-app/public',
];

/** Where each of shadcn-ui's twelve keeps its `package.json` — beside it, every one (R179). */
const SHADCN_PROJECT_FILES = SHADCN_PUBLIC_DIRS.map(
  (directory) => `${directory.slice(0, directory.lastIndexOf('/'))}/package.json`,
);

/** A walk: the directories it entered, and files an adapter claims beside them. */
function walk(directories: readonly string[], files: readonly string[] = []): WalkedTree {
  return {
    directories: [...directories],
    assets: [],
    sourceFiles: files.map((relative) => ({
      path: `/repo/${relative}`,
      relative,
      extension: relative.slice(relative.lastIndexOf('.')),
      adapterId: 'json',
    })),
    unscannedFiles: [],
  };
}

/** A file no adapter claims: `Gemfile`, `artisan`, `hugo.toml` all arrive this way. */
function unscanned(relative: string): UnscannedFile {
  return {
    path: `/repo/${relative}`,
    relative,
    extension: '',
    reason: 'unclaimed-extension',
    detail: '',
  };
}

describe('detectServingRoots', () => {
  it('finds a single conventional directory', () => {
    expect(detectServingRoots(walk(['public', 'src', 'src/components'], ['package.json']))).toEqual(
      { dirs: ['public'], declared: false },
    );
  });

  it('finds `static`, which is what Hugo, Gatsby and SvelteKit call it', () => {
    expect(detectServingRoots(walk(['src', 'static'], ['package.json'])).dirs).toEqual(['static']);
  });

  it('reproduces all twelve of shadcn-ui, at every depth they sit at', () => {
    // The measurement R50 turns on. These range from two path segments to six, so a
    // detector keyed on depth is wrong on the repository that matters: the
    // `-maxdepth 3` search the build plan once described finds six of them.
    const directories = [
      ...SHADCN_PUBLIC_DIRS,
      'apps',
      'apps/v4',
      'apps/v4/app',
      'packages',
      'packages/shadcn/src',
      'templates',
    ].sort();

    expect(detectServingRoots(walk(directories, SHADCN_PROJECT_FILES)).dirs).toEqual(
      SHADCN_PUBLIC_DIRS,
    );
  });

  it('claims a serving root that holds nothing the engine tracks', () => {
    // Six of shadcn-ui's twelve hold no image the engine tracks, only `favicon.ico`,
    // `.gitkeep`, `robots.txt` and `manifest.json`. Requiring an asset was proposed,
    // and it finds six of twelve: the same count as the depth search, reached
    // another way. A `public/` directory is a serving root whether or not it
    // currently holds an image, because that is what the bundler thinks.
    expect(detectServingRoots(walk(['public'], ['package.json'])).dirs).toEqual(['public']);
  });

  it('says a static site has no serving root rather than guessing one', () => {
    // railsgirls-com serves from its own root. Returning nothing is what sends the
    // resolver to the project-root rung, and R48 measured identical findings either
    // way. Guessing `public` here is the behaviour R49 exists to remove.
    expect(detectServingRoots(walk(['_layouts', 'css', 'images']))).toEqual({
      dirs: [],
      declared: false,
    });
  });

  it('does not claim eleventy, whose `src` is a source directory and not a root', () => {
    expect(
      detectServingRoots(walk(['src', 'src/_data', 'src/docs'], ['package.json'])).dirs,
    ).toEqual([]);
  });

  it('never reports itself as declared, however many roots it found', () => {
    // Detection is an inference. The planner's root-link policy branches on this and
    // the report discloses it, so a detector that called its own guess a declaration
    // would defeat both.
    expect(detectServingRoots(walk(SHADCN_PUBLIC_DIRS, SHADCN_PROJECT_FILES)).declared).toBe(false);
    expect(detectServingRoots(walk([])).declared).toBe(false);
  });

  it('matches the last segment, not the path, so `public-assets` is not a root', () => {
    const tree = walk(['public-assets', 'src/publication', 'mypublic'], ['package.json']);

    expect(detectServingRoots(tree).dirs).toEqual([]);
  });

  it('matches case exactly, because on a case-sensitive disk `Public` is another directory', () => {
    expect(detectServingRoots(walk(['Public', 'STATIC'], ['package.json'])).dirs).toEqual([]);
  });

  it('takes the name set from the caller, so a framework we guessed wrong is fixable', () => {
    // The condition on R50's ruling 3: this is still a hardcoded convention list and
    // it will be wrong for some framework, so a user has to be able to say so.
    const tree = walk(['assets', 'public'], ['package.json']);

    expect(detectServingRoots(tree, ['assets']).dirs).toEqual(['assets']);
    expect(detectServingRoots(tree, []).dirs).toEqual([]);
  });

  it('sorts its result, so two runs over one tree cannot differ', () => {
    const tree = walk(
      ['b/public', 'a/public', 'c/static'],
      ['a/package.json', 'b/package.json', 'c/package.json'],
    );

    expect(detectServingRoots(tree).dirs).toEqual(['a/public', 'b/public', 'c/static']);
  });

  it('names both conventions it knows, and only those', () => {
    expect([...CONVENTIONAL_SERVING_ROOT_NAMES]).toEqual(['public', 'static']);
  });
});

/**
 * 🔴 R179 — Rinkal's rule: a folder named `public` or `static` is a website folder only if
 * the directory containing it is a PROJECT, a project file beside it. It targets exactly
 * what R171 found no rule on the text of a reference could see: a real website folder
 * belongs to a project, and a tutorial's `public/` does not. Each case below is one edge
 * of that property, and each goes red against the loosening its comment names.
 */
describe('R179: only a folder a project owns', () => {
  it('🔴 rejects a `public/` no project owns — the coverage tree’s impostor', () => {
    const tree = walk(['docs-examples', 'docs-examples/public'], ['docs-examples/guide.md']);

    expect(detectServingRoots(tree).dirs).toEqual([]);
  });

  it('🔴 is not vouched for by a project file further UP — beside means the parent', () => {
    // The loosening that looks harmless: "some ancestor is a project". Every folder in a
    // repository has one — its root — so that rule is no rule, and the impostor above is
    // exactly this shape inside the coverage tree, whose root holds a package.json.
    const tree = walk(['docs-examples', 'docs-examples/public'], ['package.json']);

    expect(detectServingRoots(tree).dirs).toEqual([]);
  });

  it('🔴 is not vouched for by a project file INSIDE the folder', () => {
    // A `package.json` under `public/` is a file the site serves, not the project the
    // folder belongs to.
    expect(detectServingRoots(walk(['public'], ['public/package.json'])).dirs).toEqual([]);
  });

  it('keeps a monorepo app’s folder, beside that app’s own package.json', () => {
    const tree = walk(['apps', 'apps/web', 'apps/web/public'], ['apps/web/package.json']);

    expect(detectServingRoots(tree).dirs).toEqual(['apps/web/public']);
  });

  it('🔴 counts a config DIRECTORY — VitePress keeps `docs/public/` beside `docs/.vitepress/`', () => {
    // VitePress's package.json is at the repository root, so a rule that looked only at
    // FILES would reject every VitePress site's `public/`.
    const tree = walk(['docs', 'docs/.vitepress', 'docs/public'], ['package.json']);

    expect(detectServingRoots(tree).dirs).toEqual(['docs/public']);
  });

  it('🔴 counts a project file no adapter claims — a Rails `Gemfile` is an unscanned file', () => {
    const tree: WalkedTree = {
      ...walk(['legacy', 'legacy/public']),
      unscannedFiles: [unscanned('legacy/Gemfile')],
    };

    expect(detectServingRoots(tree).dirs).toEqual(['legacy/public']);
  });

  it('knows Hugo, Laravel and Angular by their files — each untested on a real repository', () => {
    expect(detectServingRoots(walk(['static'], ['hugo.toml'])).dirs).toEqual(['static']);
    expect(detectServingRoots(walk(['static'], ['config.toml'])).dirs).toEqual(['static']);
    expect(detectServingRoots(walk(['public'], ['composer.json'])).dirs).toEqual(['public']);
    expect(detectServingRoots(walk(['public'], ['angular.json'])).dirs).toEqual(['public']);
    const laravel: WalkedTree = { ...walk(['public']), unscannedFiles: [unscanned('artisan')] };
    expect(detectServingRoots(laravel).dirs).toEqual(['public']);
  });

  it('takes the marker list from the caller, as it takes the names', () => {
    // A framework whose project file this list does not know is fixable the same way a
    // folder name is: Phoenix's `mix.exs`, say.
    const tree = walk(['public'], ['mix.exs']);

    expect(detectServingRoots(tree).dirs).toEqual([]);
    expect(detectServingRoots(tree, CONVENTIONAL_SERVING_ROOT_NAMES, ['mix.exs']).dirs).toEqual([
      'public',
    ]);
    expect(detectServingRoots(walk(['public'], ['package.json']), undefined, []).dirs).toEqual([]);
  });

  it('names every project file it knows, so adding one is a visible change', () => {
    expect([...PROJECT_MARKERS]).toEqual([
      'package.json',
      '.vitepress',
      'hugo.toml',
      'hugo.yaml',
      'hugo.json',
      'config.toml',
      'config.yaml',
      'config.json',
      'Gemfile',
      'composer.json',
      'artisan',
      'angular.json',
    ]);
  });
});
