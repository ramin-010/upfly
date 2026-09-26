/**
 * Link assets and references into the structure the audit reads.
 *
 * A pure function over what `discover`, `scan` and `resolve` produced. Every reference the
 * resolver returned appears somewhere in the result, because a silent skip is a bug and a
 * graph is the easiest place to lose one. Linking goes through `linkedPaths`, never a
 * comparison of `resolution`, so a pattern reference such as `` `./img/${name}.png` ``
 * links every asset it matched. See "The graph" in ARCHITECTURE.md.
 */

import { UpflyError } from './errors.js';
import { compareStrings, relativePath } from './paths.js';
import { linkedPaths } from './reference.js';
import type { Asset, Reference, Resolution, UnscannedExtension, UnscannedFile } from './types.js';
import { countExtensions } from './unscanned.js';

/** One asset and every reference that points at it. */
export interface AssetNode {
  readonly asset: Asset;
  /**
   * References linked to this asset, in report order.
   *
   * Empty means the audit has a `dead` or `possibly-dead` candidate. Which of the two
   * depends on whether the audit's filename sweep finds the asset mentioned somewhere.
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
   * The audit's `broken` findings and the report's per-outcome counts come straight from
   * here, so a reference cannot go missing from the report without also going missing
   * from a bucket.
   */
  readonly byResolution: Readonly<Record<Resolution, readonly Reference[]>>;
  /**
   * Every file the engine saw but did not read, sorted by `relative`.
   *
   * The audit sweeps these for the filenames of zero-reference assets, so it can say
   * "`hero.png` is named in `config.yaml`, which Upfly cannot parse" instead of hedging
   * every asset because some extension went unread.
   */
  readonly unscannedFiles: readonly UnscannedFile[];
  /**
   * The same files counted by extension, sorted by `ext`: the report's coverage statement,
   * and how a user finds out they want an adapter.
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
   * Every file that went unread, from both sources: `DiscoveryResult.unscannedFiles`
   * (extensions no adapter claims) and `ScanResult.unscanned` (parse failures and files
   * that vanished). They are one list because the audit need not tell them apart: in both
   * cases the engine did not learn what the file references.
   */
  readonly unscannedFiles: readonly UnscannedFile[];
}

/**
 * Build the graph: link each reference to the assets it resolved to, and bucket every
 * reference by outcome.
 *
 * @throws {UpflyError} `GRAPH_UNKNOWN_ASSET` if a reference links to a path that is not in
 * the asset set. That cannot happen when the references were resolved against these same
 * assets, only against a different asset set, such as a cached one. It throws because
 * dropping the link would show up as a phantom dead asset.
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

/** Assets nothing links to: the audit's `dead` and `possibly-dead` candidates. */
export function unreferencedAssets(graph: Graph): readonly AssetNode[] {
  return graph.assets.filter((node) => node.references.length === 0);
}

/**
 * Bucket every reference by outcome.
 *
 * The record literal is what makes this exhaustive: `Record<Resolution, …>` requires
 * every key, so an eighth resolution outcome fails to compile here rather than
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
 * By POSIX-relative path, not `Reference.file`: that absolute native path uses `\` on
 * Windows, which sorts on the other side of the alphanumerics from `/`, so the order would
 * differ between platforms. The relative path is computed once per reference rather than
 * inside the comparator, which would recompute it O(n log n) times.
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
