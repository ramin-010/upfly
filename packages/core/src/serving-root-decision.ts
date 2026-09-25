/**
 * The serving roots for a run whose project has not declared them: the directories
 * detection finds by name, plus those inference finds by what the references resolve.
 *
 * Inference only adds; it never removes a detected root. It exists for a site served from a
 * directory no naming rule can reach, such as Eleventy's `src/`. The union is sorted for
 * deterministic output only, since the resolver orders roots by ancestor depth itself. The
 * reasoning is in ARCHITECTURE.md, under "Inference: what the references resolve against".
 */

import { type InferredServingRoots, inferServingRoots } from './infer-serving-roots.js';
import { IMAGE_EXTENSIONS, compareStrings, toPosix } from './paths.js';
import type { ServingRoots } from './resolve.js';
import { type WalkedTree, detectServingRoots } from './serving-roots.js';
import type { RawReference } from './types.js';

const IMAGE_SUFFIXES = new Set(IMAGE_EXTENSIONS);

/** Whether a path is written from the URL root. `//host/x` is protocol-relative and is not. */
export function isRootRelative(raw: string): boolean {
  return raw.startsWith('/') && !raw.startsWith('//');
}

/**
 * Whether a path ends in an image extension, ignoring a query or fragment.
 *
 * Inference scores the references a root could serve, so it counts only paths that could
 * name an image. Page links such as `/en/guides/deploy/` would otherwise drag a real serving
 * root's score towards zero.
 */
export function looksLikeAsset(raw: string): boolean {
  const withoutQuery = raw.split('?')[0]?.split('#')[0] ?? raw;
  const cut = withoutQuery.lastIndexOf('.');
  if (cut === -1) return false;
  return IMAGE_SUFFIXES.has(withoutQuery.slice(cut).toLowerCase());
}

export interface ServingRootDecision {
  /** Detection and inference together, sorted. What the resolver is given. */
  readonly servingRoots: ServingRoots;
  /** What the name-based rule found on its own. */
  readonly detected: readonly string[];
  /** The inference's full answer, including the ties it refused to break. */
  readonly inferred: InferredServingRoots;
  /** Roots inference contributed that detection did not have. */
  readonly added: readonly string[];
  /**
   * How many references inference scored. Zero reads like a project with nothing to infer
   * but means inference had no evidence at all, so it is reported rather than hidden.
   */
  readonly assetReferences: number;
}

export interface ServingRootDecisionInput extends WalkedTree {
  /** The walk's root, absolute, used only to make a reference's file path relative. */
  readonly root: string;
  /** The scan's references. Only root-relative paths that could name an image are scored. */
  readonly references: readonly RawReference[];
  /** Conventional directory names, for a caller that overrides `detectServingRoots`' default. */
  readonly names?: readonly string[];
  /** Files that make a directory a project, for a caller that overrides the default. */
  readonly markers?: readonly string[];
}

/**
 * Decides where root-relative paths are served from when the project has not said.
 *
 * @param input the finished walk and the scan's references
 * @returns the roots, marked `declared: false`, with how each one was found
 */
export function decideServingRoots(input: ServingRootDecisionInput): ServingRootDecision {
  // The whole walk, not only its directories: a project file beside a `public/` may be one
  // no adapter claims, such as a `Gemfile`.
  const detected = detectServingRoots(input, input.names, input.markers);

  const root = toPosix(input.root);
  const filtered: { file: string; path: string }[] = [];
  for (const reference of input.references) {
    if (!isRootRelative(reference.rawPath)) continue;
    if (!looksLikeAsset(reference.rawPath)) continue;
    const file = toPosix(reference.file);
    // A reference from outside the walked tree cannot be made relative to it, and slicing
    // anyway would produce a path that starts mid-directory.
    if (!file.startsWith(`${root}/`)) continue;
    filtered.push({ file: file.slice(root.length + 1), path: reference.rawPath });
  }

  const inferred = inferServingRoots({
    assets: input.assets.map((asset) => asset.relative),
    references: filtered,
  });

  const added = inferred.dirs.filter((dir) => !detected.dirs.includes(dir));
  const dirs = [...detected.dirs, ...added].sort(compareStrings);

  return {
    // Nobody stated these roots, so the report says they were worked out.
    servingRoots: { dirs, declared: false },
    detected: detected.dirs,
    inferred,
    added,
    assetReferences: filtered.length,
  };
}
