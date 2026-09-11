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
import { splitPathSuffix, staticExtensionOf } from './adapters/reference-path.js';
import type { AliasMap } from './aliases.js';
import { expandAlias } from './aliases.js';
import { compareStrings, extensionOf, isImageExtension, toPosix } from './paths.js';
import type { Asset, ExcludedRoot, RawReference, Reference, ResolvedVia } from './types.js';

export interface ResolveOptions {
  /** Absolute project root, as returned by `discover`. */
  readonly root: string;
  /** Every image found on disk. Resolution is against this set, not the filesystem. */
  readonly assets: readonly Asset[];
  /**
   * Directories a root-relative `/hero.png` may be served from, relative to the root.
   *
   * Defaults to `['public']`, which is right for a single-app Vite, Next or Astro
   * project. A plain static site serves from the root itself: `['']`.
   *
   * **A list, because a monorepo has more than one.** shadcn-ui has six, and a file
   * under `apps/v4/` that references `/images/hero.png` means `apps/v4/public/`,
   * not the one at the workspace root. Resolving that against a single serving root
   * produced 93 false `broken` findings on it — and zero false `broken` is the
   * phase's exit criterion.
   *
   * Order within the list does not decide precedence: the **nearest ancestor of the
   * referencing file wins**, which is what a bundler does. See `candidatePaths`.
   */
  readonly publicDirs?: readonly string[];
  /**
   * Directories the walk excluded, from `DiscoveryResult.excludedRoots`.
   *
   * A reference into one of these points at a file that really is there, so calling
   * it `broken` is a false positive — and the likeliest case is not `node_modules`
   * but a user who ignores `legacy/` while it is still referenced.
   */
  readonly excludedRoots?: readonly ExcludedRoot[];
  /**
   * Path aliases the project declares, from `loadAliases`.
   *
   * Passed in rather than read here, because reading a config is filesystem work and
   * this module is pure. Absent means "no aliases were loaded", which leaves every
   * alias-shaped path in `unresolved-alias` exactly as before.
   */
  readonly aliases?: AliasMap;
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
    publicDirs: options.publicDirs ?? ['public'],
    excludedRoots: options.excludedRoots ?? [],
    exists: options.exists,
    aliases: options.aliases ?? { rules: [], skipped: [] },
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
  readonly publicDirs: readonly string[];
  readonly excludedRoots: readonly ExcludedRoot[];
  readonly exists: (absolutePath: string) => boolean;
  readonly aliases: AliasMap;
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
  const { index, root, publicDirs } = context;
  // 1. No static path at all.
  if (raw.ceiling === 'unsafe') {
    return provablyNotAnAsset(raw) ? null : unlinked(raw, 'dynamic');
  }

  // 2. A pattern. Glob it; never let it fall through to `broken`.
  if (raw.ceiling === 'medium') {
    const { matches, via } = index.matchPattern(raw.rawPath, raw, root, publicDirs);
    const [first, ...rest] = matches;
    if (first === undefined) {
      return provablyNotAnAsset(raw) ? null : unlinked(raw, 'dynamic');
    }
    return {
      ...raw,
      resolution: 'resolved-pattern',
      confidence: 'medium',
      resolvedPaths: [first, ...rest],
      resolvedVia: via,
    };
  }

  const { path } = splitPathSuffix(raw.rawPath);

  // 3. Not a file we track. Dropped entirely, with no report line.
  if (!isImageExtension(extensionOf(path))) return null;

  // 4. Points at an asset we found.
  const target = index.lookup(path, raw, root, publicDirs);
  if (target !== null) {
    return {
      ...raw,
      resolution: 'resolved',
      confidence: raw.ceiling,
      resolvedPath: target.path,
      resolvedVia: target.via,
    };
  }

  // 4b. An alias the project declares. Tried after the literal lookup, so a real file
  //     at the written path always wins over a mapping that happens to match.
  const viaAlias = resolveThroughAlias(path, raw, context);
  if (viaAlias !== null) return viaAlias;

  // 5. Points at a real file we deliberately do not index.
  const excluded = outOfScope(path, raw, context);
  if (excluded !== null) return excluded;

  // 6. Alias-shaped and no declared alias matched.
  if (isAliasShaped(path, raw.kind)) {
    // ⚠️ R32 — an npm package specifier is NOT an alias, and must not sit in a bucket
    // that promises a resolution alias resolution will never deliver. `unresolved-alias`
    // means *"we expect to resolve this once aliases land"*: it is a promise, not a
    // description. `resolveModule('@11ty/logo/img/logo-96x96.png')` points into
    // `node_modules`, which is pruned — known, and known not to be an indexed asset,
    // which is precisely what `out-of-scope` is defined as.
    if (isPackageSpecifier(path, raw.kind)) {
      return {
        ...raw,
        resolution: 'out-of-scope',
        confidence: 'unsafe',
        resolvedPath: path,
        exclusionReason: 'names a file inside an npm package, which is not an indexed asset',
      };
    }
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
  for (const { path: candidate } of candidatePaths(path, raw, context.root, context.publicDirs)) {
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

/**
 * A reference whose **statically visible** suffix rules out an image.
 *
 * `components/ui/${name}.tsx` needs no resolution: the extension is right there and
 * it is not one we track. Dropped exactly as rung 3 drops `url(inter.woff2)`, and for
 * the same reason — it was never a candidate asset, so declining it is not a skip
 * under rule 9.
 *
 * Found by §5.1(d)'s cold read. `34 references could not be resolved safely` listed
 * 106 entries with **no image among them**, and that bucket is what §1.1 shows a user
 * as *"references I couldn't safely rewrite"*. On `shadcn-ui`, **127 of 187** carried
 * a static non-image extension: `.json` ×74, `.tsx` ×18, `.ts` ×11, `.bak` ×4.
 *
 * ⚠️ **Not the same as moving rung 3 earlier**, which is pinned by a test in both
 * directions and would swallow `url($hero)`. `$hero` shows no static extension at
 * all, so it stays — unknown is not the same as ruled out, and the difference is the
 * whole point.
 */
function provablyNotAnAsset(raw: RawReference): boolean {
  const extension = staticExtensionOf(raw.rawPath);
  return extension !== '' && !isImageExtension(extension);
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
/**
 * Rung 4b: expand a declared alias and look the result up.
 *
 * Separate from `resolveOne` so the ladder stays readable as a ladder — and because
 * the expansion can produce several candidates, which is a loop the surrounding
 * sequence of single tests should not have to carry.
 */
function resolveThroughAlias(
  path: string,
  raw: RawReference,
  context: ResolveContext,
): Reference | null {
  if (!isAliasShaped(path, raw.kind)) return null;

  for (const candidate of expandAlias(context.aliases, path, raw.file)) {
    const target = context.index.lookupExact(candidate);
    if (target === null) continue;
    return {
      ...raw,
      resolution: 'resolved',
      confidence: raw.ceiling,
      resolvedPath: target,
      // `serving-root`, not a new value: an alias is a **configured** base the user
      // stated, exactly like a serving root, and it is as strong. An eighth
      // `resolvedVia` would make every consumer handle a case that behaves
      // identically to one it already handles.
      resolvedVia: 'serving-root',
    };
  }
  return null;
}

/**
 * Whether an alias-shaped path is really a **package** specifier (R32).
 *
 * The two look alike and mean opposite things. `@/assets/logo.png` is the Next and
 * Vite alias convention — an empty scope, which no package registry permits — while
 * `@11ty/logo/img/logo.png` is a scoped package, and a bare `lodash/x.png` in an
 * `import` is an unscoped one. A package's files live in `node_modules`, which the
 * walk prunes, so no amount of alias configuration will ever resolve them.
 *
 * Measured scope when this was ruled: 4 references, 1 file, 1 repository, zero
 * elsewhere — all four `resolveModule('@11ty/logo/…')` in `eleventy.config.js`.
 */
function isPackageSpecifier(path: string, kind: RawReference['kind']): boolean {
  // `@scope/name/…` — a non-empty scope. `@/…` has an empty one and is the alias.
  if (/^@[^/]+\//.test(path)) return true;
  // A bare specifier in an import position: `lodash/x.png`, never `./x.png`.
  if (kind !== 'import') return false;
  // `@` is excluded here because the scoped-package case is already decided above: an
  // `@`-leading path that is not `@scope/name` is `@/…`, the alias convention.
  return (
    !path.startsWith('.') &&
    !path.startsWith('/') &&
    !path.startsWith('~') &&
    !path.startsWith('#') &&
    !path.startsWith('@')
  );
}

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
  lookup(
    path: string,
    raw: RawReference,
    root: string,
    publicDirs: readonly string[],
  ): Candidate | null {
    for (const candidate of candidatePaths(path, raw, root, publicDirs)) {
      const match = this.byPath.get(candidate.path);
      if (match !== undefined) return { path: match, via: candidate.via };
    }
    return null;
  }

  /**
   * The asset at an already-absolute POSIX path, or `null`.
   *
   * Separate from `lookup` because an expanded alias is already a complete path: the
   * base came from the config, so re-running the file-relative and serving-root
   * candidate generation over it would be asking the same question twice with the
   * wrong inputs.
   */
  lookupExact(path: string): string | null {
    return this.byPath.get(path) ?? null;
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
    publicDirs: readonly string[],
  ): { matches: readonly string[]; via: ResolvedVia } {
    const { path } = splitPathSuffix(rawPath.replace(/\$\{[^}]*\}/g, HOLE));

    for (const candidate of candidatePaths(path, raw, root, publicDirs)) {
      const matches: string[] = [];
      const pattern = globRegex(candidate.path);
      for (const assetPath of this.ordered) {
        if (!pattern.test(assetPath)) continue;
        const native = this.byPath.get(assetPath);
        if (native !== undefined && !matches.includes(native)) matches.push(native);
      }
      // The provenance has to be the candidate that actually matched, so the
      // matches and the `via` cannot disagree about which base was used.
      if (matches.length > 0) return { matches, via: candidate.via };
    }

    return { matches: [], via: 'file' };
  }
}

/**
 * Where a path might live, in the order the build plan gives.
 *
 * A relative path resolves against the file. A **root-relative** one is tried
 * against every serving root, and the order matters:
 *
 * 1. The serving root whose app directory is the **nearest ancestor** of the
 *    referencing file. A monorepo has one `public/` per app, and `/images/hero.png`
 *    inside `apps/v4/` means `apps/v4/public/` — that is what the bundler serving
 *    that app does, and resolving it against a sibling app's public directory is
 *    how 93 false `broken` findings happened on shadcn-ui.
 * 2. The project root, because a plain static site serves `/hero.png` from there.
 *
 * A serving root that is **not** an ancestor of the referencing file is not tried at
 * all — see `servingRootsFor`. That restraint is load-bearing rather than tidy:
 * without it a monorepo links one app's reference to another app's asset.
 */
/** One place a path might live, and how the engine got there. */
interface Candidate {
  readonly path: string;
  readonly via: ResolvedVia;
}

function candidatePaths(
  path: string,
  raw: RawReference,
  root: string,
  publicDirs: readonly string[],
): readonly Candidate[] {
  if (!path.startsWith('/')) {
    const relative: Candidate[] = [
      { path: toPosix(resolvePath(dirname(raw.file), path)), via: 'file' },
    ];

    // R15, and **speculative only**. In every module system `./` unambiguously
    // means file-relative, so falling back to the project root on an asserted
    // `import './missing.png'` could link a genuinely broken import to an unrelated
    // file — a false link, which is the expensive failure. A path-shaped string in
    // a data object carries no such contract: it is already a guess, and the code
    // may well join it to the project root, which is what astro-docs does. Letting
    // a guess guess harder costs it nothing it had.
    //
    // Measured before it was proposed: 14 unresolved dot-paths across the three
    // validation repos, of which exactly 2 resolve this way, and both are real.
    if (!raw.asserted) {
      relative.push({
        path: toPosix(resolvePath(root, stripDotSlash(path))),
        via: 'speculative-root',
      });
    }
    return relative;
  }

  const withoutLeadingSlash = path.slice(1);
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const add = (candidate: Candidate): void => {
    if (seen.has(candidate.path)) return;
    seen.add(candidate.path);
    candidates.push(candidate);
  };

  for (const publicDir of servingRootsFor(publicDirs, raw.file, root)) {
    add({ path: toPosix(resolvePath(root, publicDir, withoutLeadingSlash)), via: 'serving-root' });
  }

  // The project root, when no configured serving root claimed it. A plain static
  // site really does serve `/hero.png` from here — but if the caller named its
  // serving roots and none matched, this is a fallback rather than a statement,
  // which is why it is recorded as one.
  add({ path: toPosix(resolvePath(root, withoutLeadingSlash)), via: 'project-root' });
  return candidates;
}

/** `./a/b.png` -> `a/b.png`, leaving `../` alone: that really is file-relative. */
function stripDotSlash(path: string): string {
  return path.startsWith('./') ? path.slice(2) : path;
}

/**
 * The serving roots that could plausibly serve *this* file, nearest first.
 *
 * **Only ancestors.** A serving root's app directory is its parent —
 * `apps/v4/public` belongs to the app at `apps/v4` — and a file outside that app is
 * not served by it. Trying every root regardless looked harmless ("more roots can
 * only turn a false `broken` into a correct link") and is not: measured on
 * shadcn-ui, it linked 23 references to **another app's asset**, including a
 * fixture app's `/next.svg` to `apps/v4/public/next.svg`. Phase 2 would then rewrite
 * that reference to point at a file the fixture app does not serve — silent
 * corruption, which is the failure this project exists to prevent.
 *
 * The guarantee is only true when every root serves the same URL space. In a
 * monorepo they do not, so proximity has to *filter*, not merely order.
 *
 * A single configured root is always an ancestor (its app directory is the project
 * root), so the ordinary single-app case is unchanged.
 */
function servingRootsFor(
  publicDirs: readonly string[],
  fromFile: string,
  root: string,
): readonly string[] {
  const file = toPosix(fromFile);
  const projectRoot = toPosix(resolvePath(root));

  const ancestors = publicDirs.flatMap((publicDir) => {
    const served = toPosix(resolvePath(root, publicDir));
    // `publicDir: ''` means the project root itself serves the URL space; its app
    // directory is the root, not the root's parent.
    const appDirectory = served === projectRoot ? projectRoot : toPosix(resolvePath(served, '..'));
    if (file !== appDirectory && !file.startsWith(`${appDirectory}/`)) return [];
    return [{ publicDir, depth: appDirectory.length }];
  });

  return ancestors
    .sort((a, b) => b.depth - a.depth || compareStrings(a.publicDir, b.publicDir))
    .map((entry) => entry.publicDir);
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
