import { describe, expect, it } from 'vitest';
import {
  CONVENTIONAL_SERVING_ROOT_NAMES,
  PROJECT_MARKERS,
  type WalkedTree,
  detectServingRoots,
} from './serving-roots.js';
import type { UnscannedFile } from './types.js';

/**
 * The twelve `public/` directories of shadcn-ui at its pinned commit, as listed in
 * `bench/src/repos.ts`. `pnpm --filter upfly-bench run detect-roots` checks detection
 * against that list on the real repository.
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

/** Each of shadcn-ui's twelve has a `package.json` beside it, in its parent directory. */
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
    // These range from two path segments to six, so a detector keyed on depth is wrong
    // on this repository: a `-maxdepth 3` search finds six of them.
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
    // Six of shadcn-ui's twelve hold no image the engine tracks, only files such as
    // `favicon.ico` and `robots.txt`, so a rule that required an asset would find six. A
    // `public/` directory is a serving root whether or not it holds an image, because
    // the bundler serves it either way.
    expect(detectServingRoots(walk(['public'], ['package.json'])).dirs).toEqual(['public']);
  });

  it('says a static site has no serving root rather than guessing one', () => {
    // railsgirls-com serves from its own root. Returning nothing sends the resolver to
    // its project-root fallback, which is right for such a site, and guessing `public`
    // is not.
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
    // The names are a hardcoded convention list and will be wrong for some framework, so
    // a user has to be able to say so.
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
 * A folder named `public` or `static` is a website folder only if the directory holding it
 * is a project, with a project file beside the folder. No rule on the text of a reference
 * can tell a tutorial's `public/` from a real one, but ownership can. Each case below is
 * one edge of that rule, and fails against the loosening its comment names.
 */
describe('only a folder a project owns is a serving root', () => {
  it('rejects a `public/` no project owns, as in the coverage tree', () => {
    const tree = walk(['docs-examples', 'docs-examples/public'], ['docs-examples/guide.md']);

    expect(detectServingRoots(tree).dirs).toEqual([]);
  });

  it('is not vouched for by a project file further up, only by one in the parent', () => {
    // The loosening that looks harmless is "some ancestor is a project". Every folder in
    // a repository has one, its root, so that is no rule at all: the case above has this
    // shape inside the coverage tree, whose root holds a `package.json`.
    const tree = walk(['docs-examples', 'docs-examples/public'], ['package.json']);

    expect(detectServingRoots(tree).dirs).toEqual([]);
  });

  it('is not vouched for by a project file inside the folder', () => {
    // A `package.json` under `public/` is a file the site serves, not the project the
    // folder belongs to.
    expect(detectServingRoots(walk(['public'], ['public/package.json'])).dirs).toEqual([]);
  });

  it('keeps a monorepo app’s folder, beside that app’s own package.json', () => {
    const tree = walk(['apps', 'apps/web', 'apps/web/public'], ['apps/web/package.json']);

    expect(detectServingRoots(tree).dirs).toEqual(['apps/web/public']);
  });

  it('counts a config directory, as VitePress keeps `docs/public/` beside `docs/.vitepress/`', () => {
    // VitePress keeps its `package.json` at the repository root, so a rule that looked
    // only at files would reject every VitePress site's `public/`.
    const tree = walk(['docs', 'docs/.vitepress', 'docs/public'], ['package.json']);

    expect(detectServingRoots(tree).dirs).toEqual(['docs/public']);
  });

  it('counts a project file no adapter claims, such as a Rails `Gemfile`', () => {
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
