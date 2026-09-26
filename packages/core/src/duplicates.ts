/**
 * Assets whose bytes are identical, as happens when someone copies an image.
 *
 * Grouped by content hash, never by name: a copy is often renamed, and two files whose
 * names share nothing can hold the same image. It is a finding, not a change: it reports
 * each set and the bytes that keeping one copy would recover, and never picks a copy to
 * keep, since that depends on intent the engine cannot see.
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
   * What deleting every copy but one would recover: `bytes × (copies − 1)`. Not the total
   * the set occupies, because one copy has to survive.
   */
  readonly wastedBytes: number;
}

/**
 * The assets worth hashing for `findDuplicates`: those whose size another asset shares,
 * sorted by path.
 *
 * Byte-identical files have equal sizes, so an asset with a unique size cannot be a
 * duplicate and never needs to be read. Hashing reads a whole file, so this is what keeps
 * the check cheap. Zero-byte files are left out: they are all identical, which is true
 * and useless, and a repository of empty placeholders would produce one large set that
 * buries the real ones.
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
 * Groups assets into sets of identical bytes, largest recoverable size first.
 *
 * `hashes` maps a POSIX-relative path to its content hash, and only the assets in it are
 * considered, so it needs to hold only the assets `hashCandidates` returns.
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
