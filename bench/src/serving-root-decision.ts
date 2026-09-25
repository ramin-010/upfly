/**
 * Serving roots for a real run: what the directories are CALLED, plus what they RESOLVE.
 *
 * 🔴 **R132's primitive was built, exported and tested and nothing called it.** R128 ruled
 * R71 in on a measurement that earns it — **+42.9 points reference-weighted over 201
 * directories**, and a wrong root never once beat a right one — and R132 set the bar at a
 * volume floor of 3 and a rate floor of 40%. This is the wiring, and the wiring is where
 * the two mistakes live.
 *
 * ## ⚠️ MISTAKE ONE: the order the pipeline runs in
 *
 * `detectServingRoots` asks a question about **directories**, which exist as soon as the
 * walk finishes. `inferServingRoots` asks a question about **references**, which do not
 * exist until the scan finishes. So detection could run before the scan and inference
 * cannot. ✅ `pipeline.ts` already decided serving roots *after* `scanSources` — the
 * callback simply was not given the scan's output — so the reorder this needed had
 * already been paid for, and what is here is the parameter it was missing.
 *
 * ## 🔴 MISTAKE TWO: the denominator, and it is the one that hides
 *
 * `inferServingRoots` scores *references a root could serve*, so the caller must hand it
 * **references that could name an asset.** The first version of R71's instrument did not,
 * and markdown's `[label](/en/guides/deploy/)` — a reference the adapter emits and the
 * resolver later drops on the extension rung — made **astro-docs' `public` score 0.1% and
 * eleventy-docs' `src` 2.7%, on repositories where those directories ARE the serving
 * root.** ⚠️ **It depressed every candidate equally, so the RANKING stayed right and only
 * the rates were nonsense** — the kind of wrong number that survives a glance.
 *
 * The filter lives here, once, and `root-inference.ts` imports it rather than keeping its
 * own copy. Two implementations of a denominator is how the two disagree later.
 *
 * ## ✅ Why a union, and why the order of the union does not matter
 *
 * Inference **adds**; it never removes a detected root. The case it exists for is
 * `eleventy-docs`, which serves from `src/` — a root no name-based rule can ever reach,
 * because `src` is a source directory by convention.
 *
 * The union is sorted for rule 11 and for nothing else: `resolve.ts`'s `servingRootsFor`
 * re-sorts every root by ancestor depth before trying any of them, so the order handed in
 * cannot change what resolves. ⚠️ **What CAN change is which root wins**, because a deeper
 * ancestor is tried first — that is the intended monorepo behaviour, and it is also
 * exactly the risk R132's floors are sized against. `detect-roots --delta` measures it
 * rather than assuming it.
 *
 * ✅ **R140 makes the caution free:** a root that is rejected leaves every affected
 * reference exactly where it already sat — `broken` if asserted, `discarded` if not —
 * because without inference nothing resolved those paths either. **A false reject costs
 * nothing new; a false accept creates a wrong link.**
 */

import {
  IMAGE_EXTENSIONS,
  type InferredServingRoots,
  type RawReference,
  type ServingRoots,
  type WalkedTree,
  compareStrings,
  detectServingRoots,
  inferServingRoots,
  toPosix,
} from 'upfly-core';

const IMAGE_SUFFIXES = new Set(IMAGE_EXTENSIONS);

/** A path written from the URL root. `//host/x` is protocol-relative and is not one. */
export function isRootRelative(raw: string): boolean {
  return raw.startsWith('/') && !raw.startsWith('//');
}

/**
 * Does this path even claim to be an image?
 *
 * 🔴 **The denominator.** See the file comment: without this, a repository whose markdown
 * is mostly page links scores its real serving root at 0.1%.
 */
export function looksLikeAsset(raw: string): boolean {
  const withoutQuery = raw.split('?')[0]?.split('#')[0] ?? raw;
  const cut = withoutQuery.lastIndexOf('.');
  if (cut === -1) return false;
  return IMAGE_SUFFIXES.has(withoutQuery.slice(cut).toLowerCase());
}

export interface ServingRootDecision {
  /** Detection ∪ inference, sorted. What the resolver is given. */
  readonly servingRoots: ServingRoots;
  /** What the name-based rule found on its own. */
  readonly detected: readonly string[];
  /** The inference's full answer, including the ties it refused to break. */
  readonly inferred: InferredServingRoots;
  /** Roots inference contributed that detection did not have. The reason R71 exists. */
  readonly added: readonly string[];
  /**
   * How many references survived the filter.
   *
   * 🔴 Reported rather than kept inside, because **zero is the failure that looks like a
   * clean result**: an empty denominator produces no roots, no ties and no evidence, and
   * reads identically to a repository that simply has nothing to infer.
   */
  readonly assetReferences: number;
}

export interface ServingRootDecisionInput extends WalkedTree {
  /** The walk's root, absolute, used only to relativise a reference's file path. */
  readonly root: string;
  readonly references: readonly RawReference[];
  /** Conventional names, for a caller that overrides them. `detectServingRoots`' default otherwise. */
  readonly names?: readonly string[];
  /**
   * What makes a directory a project (R179), for a caller that overrides them.
   * `detectServingRoots`' default otherwise.
   */
  readonly markers?: readonly string[];
}

export function decideServingRoots(input: ServingRootDecisionInput): ServingRootDecision {
  // The WHOLE walk, not its directories: R179's rule asks whether a project file sits
  // beside a `public/`, and a `Gemfile` or `hugo.toml` is a file no adapter claims.
  const detected = detectServingRoots(input, input.names, input.markers);

  const root = toPosix(input.root);
  const filtered: { file: string; path: string }[] = [];
  for (const reference of input.references) {
    if (!isRootRelative(reference.rawPath)) continue;
    if (!looksLikeAsset(reference.rawPath)) continue;
    const file = toPosix(reference.file);
    // A reference from outside the walked tree cannot be relativised against it, and a
    // negative slice would silently produce a path that starts mid-directory.
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
    // `declared: false` whatever we found: nobody stated these, we worked them out, and
    // the report says which. A run that inferred `src` has not been told anything.
    servingRoots: { dirs, declared: false },
    detected: detected.dirs,
    inferred,
    added,
    assetReferences: filtered.length,
  };
}
