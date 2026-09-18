/**
 * Where a root-relative reference is served from, inferred by RESOLUTION rather than by name.
 *
 * `detectServingRoots` asks what a directory is CALLED. This asks what a directory can
 * RESOLVE, which is the question `eleventy-docs` answers with `src/` — a serving root no
 * name-based rule can ever find, because `src` is a source directory by convention.
 *
 * 🔴 **R132's bar, and neither number is a preference.** R128 measured both populations
 * across 201 directories in five hand-verified repositories and the coverage tree:
 *
 * | | measured |
 * |---|---|
 * | gap between the right root and the best wrong one | **+42.9 points**, reference-weighted |
 * | directories where a wrong root beat the right one | **0**, at every volume floor tried |
 * | the impostor `docs-examples/public` | **100% on 2 references**, while genuine roots scored 45.8–80% |
 * | true roots once the volume floor is 3 | **≥ 45.8%**, against wrong roots at **≤ 0.0%** |
 *
 * ⚠️ **A RATE ALONE IS POINTED THE WRONG WAY, which is the whole finding.** The coverage
 * tree holds a directory named `public` that serves nothing and resolves one reference out
 * of one. A bar phrased *"accept above 90%"* takes that impostor and rejects all four
 * genuine roots. **Volume is the discriminator; the rate only separates the populations
 * once the thin directories are gone.**
 *
 * ✅ **And R140 says the caution is free.** A rejected root leaves every affected reference
 * exactly where it already sits — `broken` if the author asserted it, `discarded` if not —
 * because without inference nothing resolves those paths either. So a false REJECT costs
 * nothing new, while a false ACCEPT creates a wrong LINK, which R49 measured at 23 on
 * `shadcn-ui` and recorded as the worse failure: a false `broken` wastes five minutes, a
 * false link rewrites a reference to another app's asset. **Every tie therefore refuses.**
 *
 * ⚠️ **Pure, and it takes the walk's output rather than a disk.** Candidates are tested
 * against the in-memory asset set. `existsSync` per candidate per reference is tens of
 * millions of syscalls.
 */

import { compareStrings } from './paths.js';

/**
 * A directory needs this many root-relative asset references before its rate counts.
 *
 * 🔴 **This is the `docs-examples/public` constant.** That directory resolves exactly one
 * reference and one-for-one is 100%. At a floor of 2 it still passes; at 3 it is gone and
 * the two populations separate completely. Measured, not chosen.
 */
export const MIN_ROOT_REFERENCES = 3;

/**
 * How much of a directory's root-relative references a candidate must resolve.
 *
 * Sits inside the measured corridor: on the coverage tree, genuine roots scored **45.8%**
 * at worst and wrong roots **0.0%** at best once the volume floor applied. 40% is inside
 * that gap with margin either side.
 *
 * ⚠️ **It is deliberately NOT R51's 25%.** That floor answers a different question — how
 * much of a whole repository must resolve before the engine trusts its own graph — and
 * reusing a number because it is familiar is how two unrelated decisions end up coupled.
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
   * Directories where two or more candidates tied and nothing was accepted.
   *
   * 🔴 **Kept rather than dropped.** Under `audit` a tie refuses, but under `init` a human
   * is watching and R71-b rules that they are shown the candidates and may choose. A tie
   * that vanished here could not be offered there.
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
   * ⚠️ **The caller filters to references that could name an asset**, because counting
   * markdown's `[label](/en/guides/deploy/)` here measures *what share of all links are
   * images* and calls it a resolution rate. That mistake made `astro-docs`' `public` score
   * 0.1% in the first version of this measurement, and it preserved the RANKING while
   * destroying the rates — which is the kind that survives a glance.
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

  // Grouped by the referencing file's directory so the ancestor walk runs once per
  // directory, and — more importantly — so every candidate is scored on the SAME
  // references. Rates over different denominators are not comparable and subtracting
  // them is not a gap.
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

    // The walk the resolver already performs, with the NAME FILTER REMOVED: at every
    // ancestor, the ancestor itself and each of its child directories. The ancestor rung
    // is what reaches a plain static site's project root; the child rung is what reaches
    // `templates/next-app/public` from a file in `templates/next-app/src/`, which an
    // ancestors-only walk never sees. Never a sibling: resolving against another app's
    // public directory is what produced 93 false `broken` findings on `shadcn-ui`.
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
      // 🔴 Refuse rather than guess. Measured at 2 directories of 201, and the one real
      // instance is `railsgirls-com/files/galway`, where the project root and `images`
      // both resolve everything because `favicon.png` exists in both places. No inference
      // can break that tie: both answers are consistent with every byte in the repository.
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
