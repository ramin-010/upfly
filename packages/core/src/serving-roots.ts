/**
 * Where a root-relative reference is served from, worked out from the walk.
 *
 * Detection is by directory name over the directories `discover` already visited:
 * never from a framework config, and never conditional on the directory holding an
 * image. Both are measured decisions rather than preferences, and the measurements
 * that produced them are in ARCHITECTURE.md under "Serving roots".
 *
 * The expensive direction is a false positive. A missed root degrades to the
 * project-root rung and costs a false `broken`, which costs somebody five minutes. A
 * wrongly detected root resolves a reference to the wrong file, and in this phase a
 * false link rewrites that file.
 */

import { compareStrings } from './paths.js';
import type { ServingRoots } from './resolve.js';

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
 * Every walked directory whose name says it serves a URL space.
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
  directories: readonly string[],
  names: readonly string[] = CONVENTIONAL_SERVING_ROOT_NAMES,
): ServingRoots {
  const wanted = new Set(names);

  return {
    // Matched exactly rather than case-insensitively. On a case-sensitive
    // filesystem a directory called `Public` is a different directory, and claiming
    // it is the false positive that rewrites a file.
    dirs: directories
      .filter((directory) => wanted.has(lastSegment(directory)))
      .sort(compareStrings),
    declared: false,
  };
}

function lastSegment(directory: string): string {
  const slash = directory.lastIndexOf('/');
  return slash === -1 ? directory : directory.slice(slash + 1);
}
