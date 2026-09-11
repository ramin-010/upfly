/**
 * Whether a run found its serving root, and therefore whether its `broken` findings
 * mean anything.
 *
 * When almost no root-relative reference resolves, the finding is not that those
 * references are broken. The finding is that the engine could not work out where the
 * project serves files from, and every `broken` under it is a symptom being reported
 * as a diagnosis. Measured on eleventy-docs: 2 of 16 root-relative references link,
 * and the other 14 are reported broken while their targets sit on disk.
 *
 * Deliberately narrow. Only root-relative paths depend on a serving root, so only
 * those are counted; a repository whose relative imports are genuinely broken scores
 * normally here and keeps its findings, and the diagnosis this produces is correct by
 * construction rather than by being the most likely explanation.
 */

import type { Graph } from './graph.js';
import { isLinked } from './reference.js';

/**
 * Below this share of root-relative references linking, the run is not reportable.
 *
 * Measured rather than chosen, across the five validation repositories in both
 * states: configured or correctly detected, and with no serving root found at all.
 * The numbers are in ARCHITECTURE.md under "Serving roots". The two populations do
 * not overlap and do not come close to overlapping, so this sits in the gap rather
 * than at the edge of either.
 */
export const RESOLUTION_FLOOR = 0.25;

/**
 * Fewer root-relative references than this and the share is not a measurement.
 *
 * A repository with one root-relative reference that happens to be genuinely broken
 * would otherwise score zero and have its one true finding suppressed. Judgement
 * rather than measurement, and stated as such: the smallest real instance in the
 * corpus is eleventy-docs at 16.
 */
export const MINIMUM_ROOT_RELATIVE = 10;

export interface ResolutionHealth {
  /** Root-relative references that found their asset. */
  readonly linked: number;
  /**
   * Root-relative references the engine could check at all: linked plus broken.
   *
   * Excludes dynamic, speculative-and-discarded, alias-shaped and out-of-scope
   * references. None of those is evidence about a serving root: a discarded guess
   * from a lockfile says nothing about whether the site serves from `public/`, and
   * counting it would make a repository with a large `package.json` look misconfigured.
   */
  readonly checkable: number;
  /** `linked / checkable`, and 1 when there is nothing to check. */
  readonly rate: number;
  /**
   * True when the run resolved too little for its `broken` findings to be believed.
   *
   * Two conditions, both required: the share is below the floor, and there were
   * enough root-relative references for that share to mean something.
   */
  readonly servingRootUnknown: boolean;
}

export function resolutionHealth(graph: Graph): ResolutionHealth {
  let linked = 0;
  let checkable = 0;

  for (const reference of graph.references) {
    // The only references a serving root can decide. A file-relative path resolves
    // the same way whatever the serving root is.
    if (!reference.rawPath.startsWith('/')) continue;

    if (isLinked(reference)) {
      linked += 1;
      checkable += 1;
    } else if (reference.resolution === 'broken') {
      checkable += 1;
    }
  }

  const rate = checkable === 0 ? 1 : linked / checkable;

  return {
    linked,
    checkable,
    rate,
    servingRootUnknown: checkable >= MINIMUM_ROOT_RELATIVE && rate < RESOLUTION_FLOOR,
  };
}
