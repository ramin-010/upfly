/**
 * Link assets and references into the structure the audit reads.
 *
 * A pure function over data: it takes what `discover`, `scan` and `resolve`
 * produced and returns the two-way mapping between them, plus the buckets for
 * everything that did not link. Nothing is dropped on the way through — every
 * reference the resolver returned appears somewhere in the result, because rule 9
 * makes a silent skip a P0 bug and a graph is the easiest place in the pipeline to
 * lose one.
 *
 * Two things here are load-bearing beyond the obvious linking:
 *
 * **Linking goes through `isLinked`/`linkedPaths`, never `resolution === 'resolved'`.**
 * There are two linked outcomes. A pattern reference such as `` `./img/${name}.png` ``
 * links *every* asset it matched, and linking only the first would leave the rest
 * looking unreferenced — a false `dead asset` finding wearing a different costume.
 *
 * **Ordering is by POSIX-relative path, not by `Reference.file`.** `file` is an
 * absolute native path, and `/` (0x2F) and `\` (0x5C) fall on either side of the
 * alphanumerics, so sorting the raw field puts `dir/a` and `dirZ` in one order on
 * Linux and the opposite order on Windows. Rule 11 — same inputs, byte-identical
 * report — would then be quietly false in a way nothing would notice until two
 * people compared reports.
 */

import { UpflyError } from './errors.js';
import { compareStrings, relativePath } from './paths.js';
import { linkedPaths } from './reference.js';
import type { Asset, Reference, Resolution, UnscannedExtension, UnscannedFile } from './types.js';

/** One asset and every reference that points at it. */
export interface AssetNode {
  readonly asset: Asset;
  /**
   * References linked to this asset, in report order.
   *
   * Empty means the audit has a `dead` or `possibly-dead` candidate — which of the
   * two depends on whether an unscanned file mentions the asset's filename.
   */
  readonly references: readonly Reference[];
}

/** Assets, references, and what did not link. */
export interface Graph {
  /** Absolute, resolved project root. */
  readonly root: string;
  /** Every asset, sorted by `asset.relative`. */
  readonly assets: readonly AssetNode[];
  /** Every reference the resolver returned, in report order. */
  readonly references: readonly Reference[];
  /**
   * Every reference, bucketed by outcome.
   *
   * The audit's `broken` findings and the report's `discarded: N` /
   * `unresolved-alias: N` counts both come straight out of here, which makes rule 9
   * mechanical rather than remembered: a reference cannot fail to appear in the
   * report without also failing to appear in a bucket.
   */
  readonly byResolution: Readonly<Record<Resolution, readonly Reference[]>>;
  /**
   * Every file the engine saw but did not read, sorted by `relative`.
   *
   * The audit sweeps these for the filenames of zero-reference assets. That is what
   * turns "some extension went unread, so everything might be alive" — a hedge that
   * fires on every real repository and therefore says nothing — into "`hero.png` is
   * named in `config.yaml`, which Upfly cannot parse", which a person can act on.
   */
  readonly unscannedFiles: readonly UnscannedFile[];
  /**
   * The same files counted by extension, sorted by `ext`.
   *
   * No longer a trigger for anything. It is the report's coverage statement, and how
   * a user finds out they want an adapter.
   */
  readonly unscannedExtensions: readonly UnscannedExtension[];
}

export interface BuildGraphInput {
  /** Absolute project root, as returned by `discover`. */
  readonly root: string;
  /** Every asset found, from `DiscoveryResult.assets`. */
  readonly assets: readonly Asset[];
  /** Every resolved reference, from `resolveReferences`. */
  readonly references: readonly Reference[];
  /**
   * Every file that went unread — **both** sources.
   *
   * `DiscoveryResult.unscannedFiles` (extensions no adapter claims) concatenated
   * with `ScanResult.unscanned` (parse failures and files that vanished). They are
   * one list here because the audit cannot tell them apart and should not have to:
   * in both cases we did not learn what the file references.
   */
  readonly unscannedFiles: readonly UnscannedFile[];
}

/**
 * Build the graph.
 *
 * @throws {UpflyError} `GRAPH_UNKNOWN_ASSET` if a reference links to a path that is
 * not in the asset set. Unreachable in a single run — the resolver only ever returns
 * paths it took from these very assets — but reachable the moment something resolves
 * against a cached asset set, which is exactly what the editor integration will do.
 * Loud, because the quiet version of this bug is a phantom dead asset.
 */
export function buildGraph(input: BuildGraphInput): Graph {
  const references = sortForReport(input.references, input.root);
  const nodes = new Map<string, { asset: Asset; references: Reference[] }>();

  for (const asset of input.assets) nodes.set(asset.path, { asset, references: [] });

  for (const reference of references) {
    for (const path of linkedPaths(reference)) {
      const node = nodes.get(path);
      if (node === undefined) {
        throw new UpflyError(
          'GRAPH_UNKNOWN_ASSET',
          `Reference to '${reference.rawPath}' resolved to '${path}', which is not in the asset set.`,
        );
      }
      node.references.push(reference);
    }
  }

  const unscannedFiles = [...input.unscannedFiles].sort((a, b) =>
    compareStrings(a.relative, b.relative),
  );

  return {
    root: input.root,
    assets: [...nodes.values()].sort((a, b) => compareStrings(a.asset.relative, b.asset.relative)),
    references,
    byResolution: bucketByResolution(references),
    unscannedFiles,
    unscannedExtensions: countExtensions(unscannedFiles),
  };
}

/** Assets nothing links to — the audit's `dead` / `possibly-dead` candidates. */
export function unreferencedAssets(graph: Graph): readonly AssetNode[] {
  return graph.assets.filter((node) => node.references.length === 0);
}

/**
 * Bucket every reference by outcome.
 *
 * The record literal is what makes this exhaustive: `Record<Resolution, …>` requires
 * every key, so an eighth resolution outcome fails to compile *here* rather than
 * quietly vanishing from the report. That is the same guarantee the `never`-typed
 * default gives `linkedPaths`, without the switch.
 */
function bucketByResolution(references: readonly Reference[]): Record<Resolution, Reference[]> {
  const buckets: Record<Resolution, Reference[]> = {
    resolved: [],
    'resolved-pattern': [],
    'out-of-scope': [],
    dynamic: [],
    broken: [],
    discarded: [],
    'unresolved-alias': [],
  };

  for (const reference of references) buckets[reference.resolution].push(reference);
  return buckets;
}

/**
 * Sort references the way the report reads them: by file, then by position.
 *
 * The relative path is computed once per reference rather than inside the
 * comparator, which would recompute it O(n log n) times on the hot path of a
 * ten-thousand-file repository.
 */
function sortForReport(references: readonly Reference[], root: string): Reference[] {
  return references
    .map((reference) => ({ key: relativePath(root, reference.file), reference }))
    .sort(
      (a, b) =>
        compareStrings(a.key, b.key) ||
        a.reference.start - b.reference.start ||
        a.reference.end - b.reference.end,
    )
    .map((entry) => entry.reference);
}

function countExtensions(files: readonly UnscannedFile[]): UnscannedExtension[] {
  const counts = new Map<string, number>();
  for (const file of files) counts.set(file.extension, (counts.get(file.extension) ?? 0) + 1);

  return [...counts]
    .map(([ext, fileCount]) => ({ ext, fileCount }))
    .sort((a, b) => compareStrings(a.ext, b.ext));
}
