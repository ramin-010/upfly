/**
 * Where a root-relative reference is served from, worked out from the walk.
 *
 * Detection is by directory name over the directories `discover` already visited, and —
 * since R179 — only where the directory holding that name is a PROJECT: a project file
 * sits beside it. Never from a framework config's contents, and never conditional on the
 * directory holding an image. All three are measured decisions rather than preferences,
 * and the measurements that produced them are in ARCHITECTURE.md under "Serving roots".
 *
 * The expensive direction is a false positive. A missed root degrades to the
 * project-root rung and costs a false `broken`, which costs somebody five minutes. A
 * wrongly detected root resolves a reference to the wrong file, and in this phase a
 * false link rewrites that file.
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
 * What makes a directory a PROJECT: a file — or a directory — whose presence, not whose
 * contents, says a framework or a package manager lives there (R179).
 *
 * 🔴 **Why the rule exists.** A folder called `public` inside a tutorial is not a
 * website folder, and no rule on the TEXT of its references could tell it from Create
 * React App's `public/index.html` (R171): both name a root-relative file nothing outside
 * the folder mentions. What differs is whether the folder belongs to a project. Measured
 * on the five validation repositories: all 14 folders detection claims have a project
 * file beside them; the coverage tree's impostor, `docs-examples/public`, has none.
 *
 * ✅ **Not a framework config read** (ARCHITECTURE.md): a config's CONTENTS are often
 * computed JavaScript; whether a file EXISTS is as observable and static as a name.
 *
 * ⚠️ **The members, named before this was built (R166), and what they have been tested
 * on.** Only JavaScript projects are in the validation corpus, so every other line here is
 * UNTESTED on a real repository:
 * - `package.json` — Next, Vite, CRA, Astro, Nuxt, Remix, SvelteKit, Gatsby, Docusaurus,
 *   and every npm/pnpm workspace member, which those tools require to have one. Tested.
 * - `.vitepress` — a config DIRECTORY: VitePress keeps `docs/public/` beside
 *   `docs/.vitepress/`, with `package.json` at the repository root. Untested.
 * - `hugo.toml`, `hugo.yaml`, `hugo.json`, and the older `config.toml`, `config.yaml`,
 *   `config.json` — Hugo's `static/`. Untested.
 * - `Gemfile` — Rails' `public/`. Untested on a real repository.
 * - `composer.json`, `artisan` — Laravel's and Symfony's `public/`. Untested.
 * - `angular.json` — Angular's `public/` (v17 and later). Untested.
 *
 * ⚠️ **Known to be rejected, and the cheap direction (R140):** a plain HTML site with no
 * project file; Phoenix's `priv/static` and Spring Boot's `src/main/resources/static`,
 * whose project file sits further up; VuePress's `.vuepress/public`. Each costs a false
 * `broken`, never a wrong link — and declaring the folder in settings fixes it. Django's
 * `static/` is served under `/static/`, not the root, so detection by name was already
 * wrong for it; out of scope.
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
 * is as likely to be one no adapter claims — a `Gemfile`, `artisan`, `hugo.toml` land in
 * `unscannedFiles` — as one an adapter does, and a caller that passed only the source
 * files would reject every Rails app without a sound.
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

/** Every walked path, directory or file, POSIX-relative — where a marker is looked up. */
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
