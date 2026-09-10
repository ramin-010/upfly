/**
 * Decide what every raw reference points at.
 *
 * This is where confidence is finally assigned, and it is a pure function: it
 * resolves against the **asset set** `discover` returned, never against the
 * filesystem. That keeps the two-step confidence rule honest — the adapter knows
 * syntax, the resolver knows what exists — without adding a third module that
 * touches a disk.
 *
 * The whole design exists to avoid one failure: reporting something as broken when
 * it is not. Phase 1's exit criterion is zero false `broken` findings on real
 * repositories, and every branch below is there because some real syntax would
 * otherwise land in that bucket.
 */

import { dirname, resolve as resolvePath } from 'node:path';
import { splitPathSuffix } from './adapters/reference-path.js';
import { compareStrings, extensionOf, isImageExtension, toPosix } from './paths.js';
import type { Asset, ExcludedRoot, RawReference, Reference } from './types.js';

export interface ResolveOptions {
  /** Absolute project root, as returned by `discover`. */
  readonly root: string;
  /** Every image found on disk. Resolution is against this set, not the filesystem. */
  readonly assets: readonly Asset[];
  /**
   * Directory a root-relative `/hero.png` is served from, relative to the root.
   *
   * Defaults to `public`, which is right for Vite, Next and Astro. A plain static
   * site serves from the root itself, which is `''`.
   */
  readonly publicDir?: string;
  /**
   * Directories the walk excluded, from `DiscoveryResult.excludedRoots`.
   *
   * A reference into one of these points at a file that really is there, so calling
   * it `broken` is a false positive — and the likeliest case is not `node_modules`
   * but a user who ignores `legacy/` while it is still referenced.
   */
  readonly excludedRoots?: readonly ExcludedRoot[];
  /**
   * Whether a path exists on disk. Required, not optional.
   *
   * This is the resolver's only contact with a filesystem, injected rather than
   * imported so the module stays pure and testable against a fake — the same shape
   * as the `ImageProbe` port. It is consulted **only** for a reference that is about
   * to be called broken, a set that should number in the tens, and it is what stops
   * an asset excluded by a file-level ignore rule (`*.png`) from being reported as
   * missing when it is sitting right there.
   *
   * Required because a default would let a call site keep the false `broken`
   * silently, which is the failure this exists to remove.
   */
  readonly exists: (absolutePath: string) => boolean;
}

/**
 * Resolve raw references against the assets that exist.
 *
 * References to files the engine does not track — a `.woff2` font, a `.css` import —
 * are **removed** rather than reported. They were never candidate asset references,
 * so declining them is not a skip under rule 9, and counting every font in a
 * stylesheet would be pure noise.
 */
export function resolveReferences(
  rawReferences: readonly RawReference[],
  options: ResolveOptions,
): Reference[] {
  const context: ResolveContext = {
    index: new AssetIndex(options.assets),
    root: options.root,
    publicDir: options.publicDir ?? 'public',
    excludedRoots: options.excludedRoots ?? [],
    exists: options.exists,
  };
  const resolved: Reference[] = [];

  for (const raw of rawReferences) {
    const reference = resolveOne(raw, context);
    if (reference !== null) resolved.push(reference);
  }

  return resolved;
}

interface ResolveContext {
  readonly index: AssetIndex;
  readonly root: string;
  readonly publicDir: string;
  readonly excludedRoots: readonly ExcludedRoot[];
  readonly exists: (absolutePath: string) => boolean;
}

/**
 * The decision ladder from build plan §3.2, in the order it is written there.
 *
 * The ceiling tests come first because if there is no static path, every later
 * question is meaningless. The extension filter sits immediately after them rather
 * than at the very top, which matters in both directions: ahead of them it would
 * silently swallow `url($hero)` and `` `/img/${file}` `` — real dynamic references
 * with no extension to test — and behind the resolution test it would turn every
 * `url(inter.woff2)` into a `broken` finding.
 */
function resolveOne(raw: RawReference, context: ResolveContext): Reference | null {
  const { index, root, publicDir } = context;
  // 1. No static path at all.
  if (raw.ceiling === 'unsafe') {
    return unlinked(raw, 'dynamic');
  }

  // 2. A pattern. Glob it; never let it fall through to `broken`.
  if (raw.ceiling === 'medium') {
    const matches = index.matchPattern(raw.rawPath, raw, root, publicDir);
    const [first, ...rest] = matches;
    if (first === undefined) return unlinked(raw, 'dynamic');
    return {
      ...raw,
      resolution: 'resolved-pattern',
      confidence: 'medium',
      resolvedPaths: [first, ...rest],
    };
  }

  const { path } = splitPathSuffix(raw.rawPath);

  // 3. Not a file we track. Dropped entirely, with no report line.
  if (!isImageExtension(extensionOf(path))) return null;

  // 4. Points at an asset we found.
  const target = index.lookup(path, raw, root, publicDir);
  if (target !== null) {
    return { ...raw, resolution: 'resolved', confidence: raw.ceiling, resolvedPath: target };
  }

  // 5. Points at a real file we deliberately do not index.
  const excluded = outOfScope(path, raw, context);
  if (excluded !== null) return excluded;

  // 6. Alias-shaped. Phase 2 teaches the resolver tsconfig paths and Vite aliases;
  //    until then these are their own bucket, never a finding.
  if (isAliasShaped(path, raw.kind)) {
    return unlinked(raw, 'unresolved-alias');
  }

  // 7. The author said this was an asset and it points at nothing.
  if (raw.asserted) return unlinked(raw, 'broken');

  // 8. A path-shaped string that turned out not to be a path. Counted, not a finding.
  return unlinked(raw, 'discarded');
}

/**
 * Whether this path lands on a file the engine chose not to index.
 *
 * Two ways to be out of scope. The first is being under a directory the walk pruned,
 * which `discover` recorded along with the rule responsible. The second is the
 * fallback: the path is under no recorded root but the file is there anyway, which
 * happens when a *file-level* ignore rule such as `*.png` excluded it. That costs one
 * `stat` per would-be-broken reference, and zero false `broken` findings is the whole
 * exit criterion — the trade is not close.
 */
function outOfScope(path: string, raw: RawReference, context: ResolveContext): Reference | null {
  for (const candidate of candidatePaths(path, raw.file, context.root, context.publicDir)) {
    for (const excluded of context.excludedRoots) {
      const prefix = `${toPosix(excluded.path)}/`;
      if (!candidate.startsWith(prefix)) continue;
      return {
        ...raw,
        resolution: 'out-of-scope',
        confidence: 'unsafe',
        resolvedPath: candidate,
        exclusionReason: excluded.reason,
      };
    }

    if (context.exists(candidate)) {
      return {
        ...raw,
        resolution: 'out-of-scope',
        confidence: 'unsafe',
        resolvedPath: candidate,
        exclusionReason: 'resolved outside the indexed asset set',
      };
    }
  }

  return null;
}

function unlinked(
  raw: RawReference,
  resolution: 'dynamic' | 'broken' | 'discarded' | 'unresolved-alias',
): Reference {
  return { ...raw, resolution, confidence: 'unsafe', resolvedPath: null };
}

/**
 * Whether a path is written against an alias rather than the filesystem.
 *
 * `@/…`, `~/…` and `#…` are the conventional alias prefixes. A bare specifier is
 * alias-shaped too, but only in an `import`: in CSS or HTML, `images/logo.png` is an
 * ordinary relative path, while in JavaScript it is a package name.
 */
function isAliasShaped(path: string, kind: RawReference['kind']): boolean {
  if (path.startsWith('@') || path.startsWith('~') || path.startsWith('#')) return true;
  if (kind !== 'import') return false;
  return !path.startsWith('.') && !path.startsWith('/');
}

/** Placeholder standing in for a `${…}` while a template is resolved as a path. */
const HOLE = String.fromCharCode(0xe000);

/**
 * Assets, indexed for the two questions the resolver asks.
 *
 * Paths are compared POSIX-normalised so that a reference resolved on Windows and
 * the same one resolved on Linux agree.
 */
class AssetIndex {
  private readonly byPath: ReadonlyMap<string, string>;
  private readonly ordered: readonly string[];

  constructor(assets: readonly Asset[]) {
    const byPath = new Map<string, string>();
    for (const asset of assets) byPath.set(toPosix(asset.path), asset.path);
    this.byPath = byPath;
    this.ordered = [...byPath.keys()].sort(compareStrings);
  }

  /** The asset a literal path names, or `null`. */
  lookup(path: string, raw: RawReference, root: string, publicDir: string): string | null {
    for (const candidate of candidatePaths(path, raw.file, root, publicDir)) {
      const match = this.byPath.get(candidate);
      if (match !== undefined) return match;
    }
    return null;
  }

  /**
   * Every asset a template pattern names.
   *
   * All of them, deliberately. Linking only the first would leave the rest looking
   * unreferenced and produce false `dead asset` findings — the same failure the
   * `broken` rules exist to prevent, wearing a different costume.
   */
  matchPattern(
    rawPath: string,
    raw: RawReference,
    root: string,
    publicDir: string,
  ): readonly string[] {
    const { path } = splitPathSuffix(rawPath.replace(/\$\{[^}]*\}/g, HOLE));
    const matches: string[] = [];

    for (const candidate of candidatePaths(path, raw.file, root, publicDir)) {
      const pattern = globRegex(candidate);
      for (const assetPath of this.ordered) {
        if (!pattern.test(assetPath)) continue;
        const native = this.byPath.get(assetPath);
        if (native !== undefined && !matches.includes(native)) matches.push(native);
      }
      if (matches.length > 0) break;
    }

    return matches;
  }
}

/**
 * Where a path might live, in the order the build plan gives.
 *
 * A root-relative path is tried against the public directory first and the project
 * root second. Both are real serving roots in the wild — Next and Vite serve
 * `/hero.png` from `public/`, a plain static site serves it from the root — and
 * trying both can only turn a false `broken` into a correct link, never the reverse:
 * the file has to actually be there for a match to happen at all.
 */
function candidatePaths(
  path: string,
  fromFile: string,
  root: string,
  publicDir: string,
): readonly string[] {
  if (!path.startsWith('/')) {
    return [toPosix(resolvePath(dirname(fromFile), path))];
  }

  const withoutLeadingSlash = path.slice(1);
  const candidates = [toPosix(resolvePath(root, publicDir, withoutLeadingSlash))];
  const fromRoot = toPosix(resolvePath(root, withoutLeadingSlash));
  if (!candidates.includes(fromRoot)) candidates.push(fromRoot);
  return candidates;
}

/**
 * Turn a resolved path containing holes into an anchored regular expression.
 *
 * A hole becomes `[^/]*`: it matches within one path segment, so
 * `` `/img/${name}.png` `` cannot reach into a subdirectory and pull in assets the
 * author never meant. Everything else is escaped literally.
 */
function globRegex(pathWithHoles: string): RegExp {
  const escaped = pathWithHoles
    .split(HOLE)
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
  return new RegExp(`^${escaped}$`);
}
