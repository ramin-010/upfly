/**
 * Assets that ship the same pixels more than once.
 *
 * The finding that answers *"what happens when someone copies an image?"* — which
 * nothing else in the plan covered until Rinkal asked. Approved 2026-09-11 and
 * measured on `RBU-Website` at **171 sets, 176 duplicate files, 15.6 MB wasted**,
 * including a folder duplicated wholesale (`public/animationn/` and
 * `public/animationn copy/`).
 *
 * 🔴 **Grouped by CONTENT HASH, never by name**, and that was Rinkal's own correction
 * with a measurement behind it: his site holds a 0.9 MB pair — `programoffered.webp`
 * and `sideimage-gurkirt.webp` — whose names have nothing in common. **A name-based
 * check misses it entirely.** Nothing here reads a filename.
 *
 * ⚠️ **It is a FINDING, not a mutation.** Report the set and the recoverable bytes;
 * **never pick a winner and never delete** (§8 decision 7). Which copy is the real one
 * is a question about intent, and the engine has no way to know — one may be a
 * deliberate fallback, or referenced by something we cannot see.
 */

import { compareStrings } from './paths.js';
import type { Asset } from './types.js';

/** One set of byte-identical assets. Never fewer than two. */
export interface DuplicateSet {
  /** Content hash the set shares. Opaque; only equality means anything. */
  readonly hash: string;
  /** Every asset with these bytes, in path order. At least two. */
  readonly assets: readonly string[];
  /** The size of one copy. */
  readonly bytes: number;
  /**
   * What deleting every copy but one would recover: `bytes × (copies − 1)`.
   *
   * ⚠️ Deliberately **not** the total the set occupies. One copy has to survive, so
   * reporting `bytes × copies` would offer a saving that cannot be taken — the same
   * defect as quoting an encode saving that needs the original deleted to be real.
   */
  readonly wastedBytes: number;
}

/**
 * The assets worth hashing, which is almost never all of them.
 *
 * 🔴 **Two byte-identical files must have the same size**, so an asset whose size no
 * other asset shares cannot be a duplicate and does not need to be read. This is what
 * makes the check cheap in fact rather than in the spec's assumption that "the bytes
 * are already read" — nothing in the pipeline reads asset bytes today, and hashing a
 * repository's every image would have added a full extra pass over 5,370 files on
 * `railsgirls-com`.
 *
 * Zero-byte files are excluded: they are all identical to each other, which is true
 * and useless, and a repository with forty empty placeholders would produce one
 * enormous set that buries every real one.
 */
export function hashCandidates(assets: readonly Asset[]): readonly Asset[] {
  const bySize = new Map<number, Asset[]>();
  for (const asset of assets) {
    if (asset.bytes === 0) continue;
    const group = bySize.get(asset.bytes) ?? [];
    group.push(asset);
    bySize.set(asset.bytes, group);
  }

  return [...bySize.values()]
    .filter((group) => group.length > 1)
    .flat()
    .sort((a, b) => compareStrings(a.relative, b.relative));
}

/**
 * Group assets into sets of identical bytes.
 *
 * `hashes` maps a POSIX-relative path to its content hash, and only the assets in it
 * are considered — which is exactly `hashCandidates`, so an asset absent from the map
 * is one nothing could have matched rather than one we failed to check.
 */
export function findDuplicates(
  assets: readonly Asset[],
  hashes: ReadonlyMap<string, string>,
): DuplicateSet[] {
  const byHash = new Map<string, Asset[]>();
  for (const asset of assets) {
    const hash = hashes.get(asset.relative);
    if (hash === undefined) continue;
    const group = byHash.get(hash) ?? [];
    group.push(asset);
    byHash.set(hash, group);
  }

  const sets: DuplicateSet[] = [];
  for (const [hash, group] of byHash) {
    if (group.length < 2) continue;
    const paths = group.map((asset) => asset.relative).sort(compareStrings);
    const bytes = group[0]?.bytes ?? 0;
    sets.push({ hash, assets: paths, bytes, wastedBytes: bytes * (group.length - 1) });
  }

  // Largest waste first, because that is the order a reader would act in; ties broken
  // by the first path so two runs over one repository produce identical bytes.
  return sets.sort(
    (a, b) => b.wastedBytes - a.wastedBytes || compareStrings(a.assets[0] ?? '', b.assets[0] ?? ''),
  );
}
