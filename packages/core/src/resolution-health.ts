/**
 * Whether a run found its serving root, and so whether its `broken` findings can be
 * believed. When almost no root-relative reference resolves, the finding is not that those
 * references are broken but that the engine could not work out where the project serves
 * files from. Only root-relative references depend on a serving root, so only they are
 * counted, and a project whose relative imports are genuinely broken keeps its findings.
 * See "When the serving root cannot be found at all" in ARCHITECTURE.md.
 */

import type { Graph } from './graph.js';
import { isLinked } from './reference.js';

/**
 * The share of checkable root-relative references that must link for the serving root to
 * count as found. Below it, given at least `MINIMUM_ROOT_RELATIVE` of them, the audit
 * replaces the root-relative `broken` findings with one `serving-root-unknown` finding, and
 * the planner refuses.
 *
 * Measured on the five validation repositories, with a serving root and with none found:
 * the two populations do not come close to overlapping, and this sits in the gap. See
 * "When the serving root cannot be found at all" in ARCHITECTURE.md.
 */
export const RESOLUTION_FLOOR = 0.25;

/**
 * Fewer checkable root-relative references than this and the share is not a measurement,
 * so the floor does not apply. Otherwise a project whose one root-relative reference is
 * genuinely broken would score zero and see that true finding replaced by a wrong
 * diagnosis. A judgement rather than a measurement.
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
