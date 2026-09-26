/**
 * Where a root-relative reference is served from, worked out from the walk.
 *
 * Detection is by directory name over the directories `discover` visited, and only where
 * the directory holding that name is a project: a project file sits beside it. It never
 * reads a framework config, and never requires the directory to hold an image.
 * See "Serving roots" in ARCHITECTURE.md.
 *
 * A false positive is the expensive direction. A missed root degrades to the project-root
 * rung and costs a false `broken`; a wrongly detected root links a reference to the wrong
 * file, and a rewrite would then act on that link.
 */

import { compareStrings } from './paths.js';
import type { ServingRoots } from './resolve.js';
import type { DiscoveryResult } from './types.js';

/**
 * The directory names that conventionally hold a served URL space.
 *
 * `public` is Next, Vite, CRA, Astro, Nuxt and Remix; `static` is Hugo, Gatsby and
 * SvelteKit. Two names, and they will be wrong for some framework, which is why
 * `detectServingRoots` takes the set as an argument rather than reading this
 * directly. Eleventy is the known miss: it serves from `src` via
 * `addPassthroughCopy`, and `src` is a source directory rather than a serving root
 * by convention, so no name-based detector should claim it.
 */
export const CONVENTIONAL_SERVING_ROOT_NAMES: readonly string[] = Object.freeze([
  'public',
  'static',
]);

/**
 * Files or directories whose presence shows that a folder belongs to a project, so a
 * `public` or `static` folder beside one may be claimed. Only presence is checked, never
 * contents.
 *
 * `package.json` covers the JavaScript frameworks and is the only marker tested on a real
 * repository. `.vitepress` is VitePress, which keeps `package.json` at the repository root
 * rather than beside `docs/public`. `hugo.toml`, `config.toml` and their YAML and JSON
 * forms are Hugo; `Gemfile` is Rails; `composer.json` and `artisan` are Laravel and
 * Symfony; `angular.json` is Angular 17 and later. Django has no marker: its `static/` is
 * served under `/static/`, not at the root. See "Serving roots" in ARCHITECTURE.md.
 */
export const PROJECT_MARKERS: readonly string[] = Object.freeze([
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

/**
 * What detection reads from the walk: every directory it entered and every file it saw.
 *
 * The whole walk rather than a list of paths a caller assembles, because a project file
 * is as likely to be one no adapter claims (a `Gemfile`, `artisan` or `hugo.toml` lands in
 * `unscannedFiles`) as one an adapter does. A caller passing only the source files would
 * reject every Rails app without a word.
 */
export type WalkedTree = Pick<
  DiscoveryResult,
  'directories' | 'assets' | 'sourceFiles' | 'unscannedFiles'
>;

/**
 * Every walked directory whose name says it serves a URL space, and whose parent is a
 * project.
 *
 * `declared` is false because detection is an inference and not the project stating
 * anything. The planner's root-link policy already reads that distinction, and the
 * report discloses it, since a guess nobody is told about is the defect this exists
 * to fix.
 *
 * An empty result is an answer rather than a failure: a hand-written static site
 * serves from its own root, which the resolver reaches through the project-root rung
 * with no serving root at all.
 */
export function detectServingRoots(
  walk: WalkedTree,
  names: readonly string[] = CONVENTIONAL_SERVING_ROOT_NAMES,
  markers: readonly string[] = PROJECT_MARKERS,
): ServingRoots {
  const wanted = new Set(names);
  const entries = entriesOf(walk);
  const isProject = (directory: string) =>
    markers.some((marker) => entries.has(childOf(directory, marker)));

  return {
    // Matched exactly rather than case-insensitively. On a case-sensitive
    // filesystem a directory called `Public` is a different directory, and claiming
    // it is the false positive that rewrites a file.
    dirs: walk.directories
      .filter((directory) => wanted.has(lastSegment(directory)) && isProject(parentOf(directory)))
      .sort(compareStrings),
    declared: false,
  };
}

/** Every walked path, directory or file, POSIX-relative: where a marker is looked up. */
function entriesOf(walk: WalkedTree): ReadonlySet<string> {
  const entries = new Set<string>(walk.directories);
  for (const list of [walk.assets, walk.sourceFiles, walk.unscannedFiles]) {
    for (const file of list) entries.add(file.relative);
  }
  return entries;
}

function lastSegment(directory: string): string {
  const slash = directory.lastIndexOf('/');
  return slash === -1 ? directory : directory.slice(slash + 1);
}

/** `''` for a top-level directory: its parent is the project root. */
function parentOf(directory: string): string {
  const slash = directory.lastIndexOf('/');
  return slash === -1 ? '' : directory.slice(0, slash);
}

function childOf(directory: string, name: string): string {
  return directory === '' ? name : `${directory}/${name}`;
}
