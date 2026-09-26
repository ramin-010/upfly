/**
 * Serving roots inferred from what root-relative references resolve against, rather than
 * from directory names.
 *
 * `detectServingRoots` asks what a directory is called; this asks what it can resolve.
 * That finds roots no naming rule can, such as `src/` in `eleventy-docs`, where `src` is
 * a source directory everywhere else. Volume comes before rate, and a tie refuses: a
 * rejected root leaves references where they were, while a wrong one links them to the
 * wrong file. Pure: candidates are tested against the in-memory asset set, not the disk.
 * See "Inference: what the references resolve against" in ARCHITECTURE.md.
 */

import { compareStrings } from './paths.js';

/**
 * How many root-relative asset references a directory needs before its rate counts.
 *
 * A rate alone is fooled by a thin directory: the coverage tree's `docs-examples/public`
 * serves nothing, yet resolves both root-relative references in its own `example.html`.
 * At a floor of 3 it drops out, and true and wrong roots separate completely.
 */
export const MIN_ROOT_REFERENCES = 3;

/**
 * The share of a directory's root-relative references a candidate must resolve.
 *
 * Once the volume floor applies, true roots score at least 45.8% and wrong ones at most 0%
 * across the five validation repositories and the coverage tree, and 40% sits inside that
 * gap. It is not `RESOLUTION_FLOOR` (25%), which asks a different question: how much of a
 * whole repository must resolve before the engine trusts its graph.
 */
export const MIN_ROOT_RESOLUTION_RATE = 0.4;

/** One candidate's score against one directory's references. */
export interface RootCandidateScore {
  /** POSIX-relative directory. `''` is the project root. */
  readonly dir: string;
  readonly resolved: number;
  readonly attempted: number;
  readonly rate: number;
}

/** What the inference concluded, and enough of why to put in a report. */
export interface InferredServingRoots {
  /** Accepted roots, sorted. Empty is an answer: the project root serves. */
  readonly dirs: readonly string[];
  /**
   * Directories where two or more candidates tied and nothing was accepted. Kept so that
   * a caller with a person watching can show the candidates and let them choose.
   */
  readonly ties: readonly { readonly dir: string; readonly candidates: readonly string[] }[];
  /** Every accepted root with the score that accepted it, so a report can show its work. */
  readonly evidence: readonly RootCandidateScore[];
}

/** POSIX-relative directory of a POSIX-relative path. `''` for the root. */
function dirOf(relative: string): string {
  const cut = relative.lastIndexOf('/');
  return cut === -1 ? '' : relative.slice(0, cut);
}

/** Every ancestor-or-self directory, nearest first, ending at `''`. */
function ancestorsOf(dir: string): string[] {
  const out: string[] = [];
  let current = dir;
  for (;;) {
    out.push(current);
    if (current === '') break;
    current = dirOf(current);
  }
  return out;
}

export interface InferServingRootsInput {
  /** POSIX-relative paths of every asset the walk found. */
  readonly assets: readonly string[];
  /**
   * Root-relative references, as `{ file, path }` with POSIX-relative `file` and a
   * `path` beginning with `/`.
   *
   * The caller filters to references that could name an asset. Counting page links such
   * as `[label](/en/guides/deploy/)` would measure what share of links are images, which
   * keeps the ranking but makes every rate meaningless.
   */
  readonly references: readonly { readonly file: string; readonly path: string }[];
}

export function inferServingRoots(input: InferServingRootsInput): InferredServingRoots {
  const assets = new Set(input.assets);

  // Only directories that hold an asset can resolve anything, so only they compete.
  const assetDirs = new Set<string>();
  for (const asset of input.assets) {
    for (const dir of ancestorsOf(dirOf(asset))) assetDirs.add(dir);
  }

  // Grouped by the referencing file's directory, so the ancestor walk runs once per
  // directory and every candidate is scored on the same references: rates over different
  // denominators are not comparable.
  const byDir = new Map<string, string[]>();
  for (const reference of input.references) {
    if (!reference.path.startsWith('/') || reference.path.startsWith('//')) continue;
    const dir = dirOf(reference.file);
    const bucket = byDir.get(dir);
    if (bucket === undefined) byDir.set(dir, [reference.path]);
    else bucket.push(reference.path);
  }

  const accepted = new Map<string, RootCandidateScore>();
  const ties: { dir: string; candidates: readonly string[] }[] = [];

  for (const [dir, paths] of byDir) {
    if (paths.length < MIN_ROOT_REFERENCES) continue;

    // Where the resolver would look, at any name: at every ancestor, the ancestor itself
    // and each of its child directories. The ancestor reaches a plain static site's project
    // root; the child reaches `templates/next-app/public` from `templates/next-app/src/`.
    // Never a sibling: another app's public directory would link to that app's asset.
    const candidates = new Set<string>();
    for (const ancestor of ancestorsOf(dir)) {
      if (assetDirs.has(ancestor)) candidates.add(ancestor);
      const prefix = ancestor === '' ? '' : `${ancestor}/`;
      for (const assetDir of assetDirs) {
        if (!assetDir.startsWith(prefix)) continue;
        const rest = assetDir.slice(prefix.length);
        if (rest !== '' && !rest.includes('/')) candidates.add(assetDir);
      }
    }

    const scored: RootCandidateScore[] = [];
    for (const candidate of candidates) {
      let resolved = 0;
      for (const path of paths) {
        const tail = path.slice(1);
        if (assets.has(candidate === '' ? tail : `${candidate}/${tail}`)) resolved++;
      }
      scored.push({
        dir: candidate,
        resolved,
        attempted: paths.length,
        rate: resolved / paths.length,
      });
    }

    const clearing = scored.filter((score) => score.rate >= MIN_ROOT_RESOLUTION_RATE);
    if (clearing.length === 0) continue;

    const best = clearing.reduce((a, b) => (b.rate > a.rate ? b : a));
    const drawn = clearing.filter((score) => score.rate === best.rate);
    if (drawn.length > 1) {
      // Refuse rather than guess. In `railsgirls-com/files/galway` the project root and
      // `images` both resolve everything, because `favicon.png` exists in both places, and
      // nothing in the repository can break that tie.
      ties.push({ dir, candidates: drawn.map((score) => score.dir).sort(compareStrings) });
      continue;
    }

    // Keep the strongest evidence for a root claimed by several directories, so a report
    // shows the best case for accepting it rather than whichever came last.
    const existing = accepted.get(best.dir);
    if (existing === undefined || best.rate > existing.rate) accepted.set(best.dir, best);
  }

  return {
    dirs: [...accepted.keys()].sort(compareStrings),
    ties,
    evidence: [...accepted.values()].sort((a, b) => compareStrings(a.dir, b.dir)),
  };
}
