import { describe, expect, it } from 'vitest';
import { CONVENTIONAL_SERVING_ROOT_NAMES, detectServingRoots } from './serving-roots.js';

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

describe('detectServingRoots', () => {
  it('finds a single conventional directory', () => {
    expect(detectServingRoots(['public', 'src', 'src/components'])).toEqual({
      dirs: ['public'],
      declared: false,
    });
  });

  it('finds `static`, which is what Hugo, Gatsby and SvelteKit call it', () => {
    expect(detectServingRoots(['src', 'static']).dirs).toEqual(['static']);
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

    expect(detectServingRoots(directories).dirs).toEqual(SHADCN_PUBLIC_DIRS);
  });

  it('claims a serving root that holds nothing the engine tracks', () => {
    // Six of shadcn-ui's twelve hold no image the engine tracks, only `favicon.ico`,
    // `.gitkeep`, `robots.txt` and `manifest.json`. Requiring an asset was proposed,
    // and it finds six of twelve: the same count as the depth search, reached
    // another way. A `public/` directory is a serving root whether or not it
    // currently holds an image, because that is what the bundler thinks.
    expect(detectServingRoots(['public']).dirs).toEqual(['public']);
  });

  it('says a static site has no serving root rather than guessing one', () => {
    // railsgirls-com serves from its own root. Returning nothing is what sends the
    // resolver to the project-root rung, and R48 measured identical findings either
    // way. Guessing `public` here is the behaviour R49 exists to remove.
    expect(detectServingRoots(['_layouts', 'css', 'images'])).toEqual({
      dirs: [],
      declared: false,
    });
  });

  it('does not claim eleventy, whose `src` is a source directory and not a root', () => {
    expect(detectServingRoots(['src', 'src/_data', 'src/docs']).dirs).toEqual([]);
  });

  it('never reports itself as declared, however many roots it found', () => {
    // Detection is an inference. The planner's root-link policy branches on this and
    // the report discloses it, so a detector that called its own guess a declaration
    // would defeat both.
    expect(detectServingRoots(SHADCN_PUBLIC_DIRS).declared).toBe(false);
    expect(detectServingRoots([]).declared).toBe(false);
  });

  it('matches the last segment, not the path, so `public-assets` is not a root', () => {
    expect(detectServingRoots(['public-assets', 'src/publication', 'mypublic']).dirs).toEqual([]);
  });

  it('matches case exactly, because on a case-sensitive disk `Public` is another directory', () => {
    expect(detectServingRoots(['Public', 'STATIC']).dirs).toEqual([]);
  });

  it('takes the name set from the caller, so a framework we guessed wrong is fixable', () => {
    // The condition on R50's ruling 3: this is still a hardcoded convention list and
    // it will be wrong for some framework, so a user has to be able to say so.
    expect(detectServingRoots(['assets', 'public'], ['assets']).dirs).toEqual(['assets']);
    expect(detectServingRoots(['public'], []).dirs).toEqual([]);
  });

  it('sorts its result, so two runs over one tree cannot differ', () => {
    const dirs = detectServingRoots(['b/public', 'a/public', 'c/static']).dirs;

    expect(dirs).toEqual(['a/public', 'b/public', 'c/static']);
  });

  it('names both conventions it knows, and only those', () => {
    expect([...CONVENTIONAL_SERVING_ROOT_NAMES]).toEqual(['public', 'static']);
  });
});
