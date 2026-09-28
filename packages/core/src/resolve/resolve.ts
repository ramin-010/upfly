/**
 * Decide what every raw reference points at, and assign its final confidence.
 *
 * Resolution is against the asset set `discover` returned, not the filesystem: the adapter
 * knows syntax, the resolver knows what exists. Every rung of the ladder in `resolveOne`
 * exists because some real syntax would otherwise be reported as `broken` when it is not.
 * See "The resolver's seven outcomes" in ARCHITECTURE.md.
 */

import { dirname, posix, resolve as resolvePath, win32 } from 'node:path';
import {
  INTERPOLATIONS,
  type PathSpelling,
  isDrivePath,
  spellingsOf,
  splitPathSuffix,
  staticExtensionOf,
} from '../adapters/reference-path.js';
import { compareStrings, extensionOf, isImageExtension, toPosix } from '../paths.js';
import type { Asset, ExcludedRoot, RawReference, Reference, ResolvedVia } from '../types.js';
import type { AliasMap } from './aliases.js';
import { expandAlias } from './aliases.js';
import { provenPath } from './reference.js';

/**
 * The directories root-relative paths are served from, and whether the project declared
 * them or the engine guessed them.
 *
 * One value holds both, so a caller cannot pass the directories without saying where they
 * came from. A root-relative path that misses a declared root but exists at the project root
 * is suspicious; missing a guessed root says nothing, because the project never claimed to
 * serve from there. A monorepo has one root per app, and the nearest ancestor of the
 * referencing file wins, as it does for a bundler, whatever the order of `dirs`.
 */
export interface ServingRoots {
  /** Relative to the project root. A plain static site serves from the root: `['']`. */
  readonly dirs: readonly string[];
  /** True when the project declared these; false when they are a convention guess. */
  readonly declared: boolean;
}

/**
 * What to assume when the project has told us nothing.
 *
 * Right for a single-app Vite, Next or Astro project and wrong for a hand-written
 * static site, which is why it is marked as undeclared rather than passed off as a
 * statement.
 */
export const CONVENTIONAL_SERVING_ROOTS: ServingRoots = Object.freeze({
  dirs: Object.freeze(['public']) as readonly string[],
  declared: false,
});

export interface ResolveOptions {
  /** Absolute project root, as returned by `discover`. */
  readonly root: string;
  /** Every image found on disk. Resolution is against this set, not the filesystem. */
  readonly assets: readonly Asset[];
  /**
   * Where a root-relative `/hero.png` may be served from, and whether the project said so.
   * See {@link ServingRoots}.
   */
  readonly servingRoots: ServingRoots;
  /**
   * Directories the walk excluded, from `DiscoveryResult.excludedRoots`. A reference into
   * one points at a file that is really there, so it is `out-of-scope` rather than `broken`.
   * The usual case is a user who ignores `legacy/` while it is still referenced.
   */
  readonly excludedRoots?: readonly ExcludedRoot[];
  /**
   * Path aliases the project declares, from `loadAliases`. Passed in because reading a
   * config is filesystem work and this module is pure. Absent means none were loaded.
   */
  readonly aliases?: AliasMap;
  /**
   * Whether a path exists on disk: the resolver's only contact with a filesystem, injected
   * so it can be tested against a fake. It is consulted only for references that did not
   * resolve, so that an asset excluded by a file-level ignore rule such as `*.png` is
   * `out-of-scope` rather than `broken`. Required, because a default would let a call site
   * keep that false `broken` silently.
   */
  readonly exists: (absolutePath: string) => boolean;
  /**
   * The file at a path that exists but is not among `assets`, or null. A caller asking where
   * a path would lead among every file on disk, rather than among the indexed ones, passes
   * it. It is asked wherever the index misses, in the order the resolver looks, so a nearer
   * file the walk excluded is found before an asset further away. A pattern is matched
   * against `assets` only. Absent, only `assets` are found.
   */
  readonly unindexed?: (absolutePath: string) => string | null;
  /**
   * Whether an asset is found by a path that differs from its own only in case, as Windows
   * and macOS find a file. Absent, case counts, as it does on Linux. `unindexed` is asked
   * with the path as the reference spells it, and folds case itself if it has to.
   */
  readonly foldCase?: boolean;
}

/**
 * Resolve raw references against the assets that exist, giving each its outcome and final
 * confidence.
 *
 * References to files the engine does not track, such as a `.woff2` font or a `.css`
 * import, are left out of the result rather than reported. They were never candidate
 * assets, so this is not a silent skip, and counting every font in a stylesheet would be
 * noise. A value an adapter declined (`RawReference.declined`) is never looked up: it is
 * `discarded` when it names an image and left out on the same terms otherwise.
 */
export function resolveReferences(
  rawReferences: readonly RawReference[],
  options: ResolveOptions,
): Reference[] {
  const context: ResolveContext = {
    index: new AssetIndex(options.assets, options.unindexed, options.foldCase ?? false),
    root: options.root,
    publicDirs: options.servingRoots.dirs,
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
 * The resolution ladder, whose order is load-bearing. A declined value is settled before
 * anything is looked up. The ceiling tests come next because without a static path no later
 * question means anything, and the extension filter comes straight after them. Above them
 * it would drop `url($hero)` and `` `/img/${file}` ``, which have no extension to test; below
 * the rungs that turn a miss into a finding it would let every `url(inter.woff2)` be
 * reported. See "The resolver's seven outcomes" in ARCHITECTURE.md.
 */
function resolveOne(raw: RawReference, context: ResolveContext): Reference | null {
  const { index, root, publicDirs } = context;
  // 0. A value an adapter declined to read as a path. Never looked up, whatever exists on
  //    disk, so it comes before the ceiling rungs: a declined template must not glob.
  if (raw.declined === true) return namesAnImage(raw) ? unlinked(raw, 'discarded') : null;

  // 1. No static path at all. A construct the adapter could not read is text rather than a
  //    path, so what follows its last dot is no extension that could rule it out.
  if (raw.unread === true) return unlinked(raw, 'dynamic');
  if (raw.ceiling === 'unsafe') {
    return provablyNotAnAsset(raw) ? null : unlinked(raw, 'dynamic');
  }

  // 2. A pattern. Glob it, and never let it fall through to `broken`. Glob the path the
  //    text proves (`provenPath`): the text of a `+` chain, or of a template with a
  //    same-file constant written in, is not the path it builds.
  if (raw.ceiling === 'medium') {
    const pattern = provenPath(raw);
    const written = index.matchPattern(pattern, raw, root, publicDirs);
    // Then through a declared alias, as rung 4b reads a literal path, so a file at the
    // written path still wins.
    const { matches, via } =
      written.matches.length > 0
        ? written
        : { matches: matchThroughAlias(pattern, raw, context), via: 'serving-root' as const };
    const [first, ...rest] = matches;
    if (first === undefined) {
      if (provablyNotAnAsset(raw)) return null;
      // Through an alias no rule covers, a pattern is unresolved, as rung 6 calls a literal one.
      return unlinked(
        raw,
        throughUnmappedAlias(pattern, raw, context) ? 'unresolved-alias' : 'dynamic',
      );
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
  // Rungs 3, 4 and 5 ask about the same spellings. Without the kind, `spellingsOf` would not
  // read a Markdown destination's backslash escapes.
  const spellings = spellingsOf(path, raw.kind);

  // 3. Not a file we track. Dropped entirely, with no report line. Every spelling is asked,
  //    not only the written one: `hero%2Epng` shows its extension only once decoded.
  if (!spellings.some(({ path: candidate }) => isImageExtension(extensionOf(candidate)))) {
    return null;
  }

  // 4. Points at an asset we found. Every spelling, literal first: `enc%20name.png` can be a
  //    file with a percent sign in its name, while `hero%20image.png` can name
  //    `hero image.png`. Only literal-then-decoded gets both right, and the accuracy suite
  //    holds the pair so the order is tested.
  for (const { spelling, path: candidate } of spellings) {
    const found = index.lookup(candidate, raw, root, publicDirs);
    if (found === null) continue;
    return {
      ...raw,
      resolution: 'resolved',
      confidence: raw.ceiling,
      resolvedPath: found.path,
      resolvedVia: found.via,
      ...(spelling === 'literal' ? {} : { spelling }),
    };
  }

  // 4b. An alias the project declares. Tried after the literal lookup, so a real file
  //     at the written path always wins over a mapping that happens to match.
  const viaAlias = resolveThroughAlias(spellings, raw, context);
  if (viaAlias !== null) return viaAlias;

  // 5. Points at a real file we deliberately do not index, in any spelling.
  const excluded = outOfScope(path, spellings, raw, context);
  if (excluded !== null) return excluded;

  // 6. Alias-shaped and no declared alias matched. `unresolved-alias` is a final outcome,
  //    not pending work: it means no rule maps this path.
  if (aliasShapedIn(spellings, raw.kind)) {
    // 6b. A package specifier is not an alias. It names a file inside `node_modules`,
    //     which the walk prunes, so it is known and known not to be an indexed asset.
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
 * Whether this path, in any of its spellings, lands on a file the engine chose not to index:
 * under a directory the walk pruned, reported with the rule responsible, or failing that on
 * a file that exists anyway because a file-level ignore rule such as `*.png` excluded it. The
 * spellings are the ones rung 4 looked up, in its order, so `unindexed%20photo.png` finds an
 * ignored `unindexed photo.png`. An alias-shaped path is also asked about through each
 * expansion of each spelling, after the plain candidates, so an alias into a pruned folder is
 * out of scope with its rule. The fallback costs a `stat` per candidate path of each spelling
 * of a reference that did not resolve, which is cheap against a false `broken`. A
 * Windows drive path outside the project is out of scope with no `stat`: whether one machine
 * holds that file says nothing about the project.
 */
function outOfScope(
  path: string,
  spellings: ReturnType<typeof spellingsOf>,
  raw: RawReference,
  context: ResolveContext,
): Reference | null {
  if (isDrivePath(path) && drivePathInProject(path, context.root) === null) {
    return {
      ...raw,
      resolution: 'out-of-scope',
      confidence: 'unsafe',
      resolvedPath: posixDrivePath(path),
      exclusionReason:
        'names a file on a Windows drive outside the project, which is not an indexed asset',
    };
  }

  const candidates = [
    ...spellings.flatMap(({ path: spelled }) =>
      candidatePaths(spelled, raw, context.root, context.publicDirs).map(({ path: at }) => at),
    ),
    ...(aliasShapedIn(spellings, raw.kind)
      ? spellings.flatMap(({ path: spelled }) => expandAlias(context.aliases, spelled, raw.file))
      : []),
  ];
  for (const candidate of candidates) {
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
 * Whether a reference's statically visible extension rules out an image.
 *
 * `components/ui/${name}.tsx` needs no resolution: its extension is visible and not one we
 * track, so it is dropped as rung 3 drops `url(inter.woff2)`. This is not rung 3 moved
 * earlier, which would also drop `url($hero)`: `$hero` shows no extension, and an unknown
 * extension is not a ruled-out one.
 */
function provablyNotAnAsset(raw: RawReference): boolean {
  // The assembled path when there is one: `'/locales/' + lang + '.json'` shows its `.json`
  // in the path it assembles, not in the quote-and-plus text of the chain.
  const extension = staticExtensionOf(provenPath(raw));
  return extension !== '' && !isImageExtension(extension);
}

/**
 * Whether a spelling of the path a reference's text proves shows an image extension: rung 3's
 * test, asked of a value that is never looked up. A declined `/files/report.pdf` is dropped as
 * `url(inter.woff2)` is, while one naming an image is counted.
 */
function namesAnImage(raw: RawReference): boolean {
  const { path } = splitPathSuffix(provenPath(raw));
  return spellingsOf(path, raw.kind).some(({ path: spelled }) =>
    isImageExtension(staticExtensionOf(spelled)),
  );
}

function unlinked(
  raw: RawReference,
  resolution: 'dynamic' | 'broken' | 'discarded' | 'unresolved-alias',
): Reference {
  return { ...raw, resolution, confidence: 'unsafe', resolvedPath: null };
}

/**
 * Rung 4b: expand a declared alias and look the result up, in every spelling rung 4 asks
 * about, literal first, recording the spelling that matched as rung 4 does. Separate from
 * `resolveOne` because an alias can expand to several candidates, a loop the ladder's
 * sequence of single tests should not carry. Whether the path is alias-shaped is asked of
 * every spelling, since an encoding or an escape can hide an alias's first character.
 */
function resolveThroughAlias(
  spellings: readonly { readonly spelling: PathSpelling; readonly path: string }[],
  raw: RawReference,
  context: ResolveContext,
): Reference | null {
  if (!aliasShapedIn(spellings, raw.kind)) return null;

  for (const { spelling, path: spelled } of spellings) {
    for (const candidate of expandAlias(context.aliases, spelled, raw.file)) {
      const target = context.index.lookupExact(candidate);
      if (target === null) continue;
      return {
        ...raw,
        resolution: 'resolved',
        confidence: raw.ceiling,
        resolvedPath: target,
        // An alias is a base the project configured, as strong as a serving root, so it
        // reuses `serving-root` rather than adding a `resolvedVia` value every consumer
        // would handle the same way.
        resolvedVia: 'serving-root',
        ...(spelling === 'literal' ? {} : { spelling }),
      };
    }
  }
  return null;
}

/**
 * Rung 2 through a declared alias: each expansion of the pattern, in the order rung 4b tries
 * them, globbed as `matchPattern` globs a candidate, and the first that names an asset wins.
 * The holes are marked before the alias is expanded, so a key's prefix, and any text after
 * its `*`, has to lie wholly in the text the author fixed. A link through an alias is
 * recorded as `serving-root`, as rung 4b records one.
 */
function matchThroughAlias(
  pattern: string,
  raw: RawReference,
  context: ResolveContext,
): readonly string[] {
  if (!isAliasShapedPattern(pattern, raw.kind)) return [];
  for (const candidate of expandAlias(context.aliases, withHoles(pattern), raw.file)) {
    const matches = context.index.matchGlob(candidate);
    if (matches.length > 0) return matches;
  }
  return [];
}

/**
 * Whether a pattern is written through an alias no declared rule covers. A package-shaped
 * pattern is not an alias: it names files inside `node_modules`, and stays `dynamic`.
 */
function throughUnmappedAlias(
  pattern: string,
  raw: RawReference,
  context: ResolveContext,
): boolean {
  const fixed = withHoles(pattern);
  return (
    isAliasShapedPattern(pattern, raw.kind) &&
    !isPackageSpecifier(fixed, raw.kind) &&
    expandAlias(context.aliases, fixed, raw.file).length === 0
  );
}

/**
 * Whether a pattern is written against an alias, read from its fixed text. One that starts
 * with a hole, such as `${base}/img/${n}.png`, has no fixed start for an alias to be.
 */
function isAliasShapedPattern(pattern: string, kind: RawReference['kind']): boolean {
  const fixed = withHoles(pattern);
  return !fixed.startsWith(HOLE) && isAliasShaped(fixed, kind);
}

/**
 * Whether an alias-shaped path is really a package specifier.
 *
 * The two look alike and mean different things. `@/assets/logo.png` is the Next and Vite
 * alias convention, an empty scope no package registry permits, while
 * `@11ty/logo/img/logo.png` is a scoped package and a bare `lodash/x.png` in an `import` an
 * unscoped one. A package's files live in `node_modules`, which the walk prunes, so the
 * asset set never holds them.
 */
function isPackageSpecifier(path: string, kind: RawReference['kind']): boolean {
  // `@scope/name/subpath`, and the subpath is required: the `out-of-scope` reason claims a
  // file inside a package, and `@missing/astro.png` is only a scope and a name. `@/…` has
  // an empty scope and fails `[^/]+`.
  if (/^@[^/]+\/[^/]+\//.test(path)) return true;
  // A bare specifier in an import position: `lodash/x.png`, never `./x.png`.
  if (kind !== 'import') return false;
  // An `@` path was decided above: one the pattern rejected is an alias, either `@/…` or a
  // scope and name with no subpath. No npm package name starts with `$`, so `$lib/…` is an
  // alias, as SvelteKit writes one.
  return (
    !path.startsWith('.') &&
    !path.startsWith('/') &&
    !path.startsWith('~') &&
    !path.startsWith('#') &&
    !path.startsWith('@') &&
    !path.startsWith('$')
  );
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
  return !path.startsWith('.') && !path.startsWith('/') && !isDrivePath(path);
}

/**
 * Whether any spelling of a path is written against an alias: `%7E/…` decodes, and
 * Markdown's `\~/…` reads, as `~/…`.
 */
function aliasShapedIn(
  spellings: readonly { readonly path: string }[],
  kind: RawReference['kind'],
): boolean {
  return spellings.some(({ path }) => isAliasShaped(path, kind));
}

/** Stands in for an interpolation (`${…}`, `#{…}` or `@{…}`) while a template is globbed. */
const HOLE = String.fromCharCode(0xe000);

/**
 * Assets, indexed for the resolver's lookups.
 *
 * Paths are compared POSIX-normalised so that a reference resolved on Windows and
 * the same one resolved on Linux agree, and lower-cased as well when case is folded.
 */
class AssetIndex {
  private readonly byPath: ReadonlyMap<string, string>;
  private readonly ordered: readonly string[];
  private readonly unindexed: (path: string) => string | null;
  private readonly foldCase: boolean;

  /**
   * @param unindexed see `ResolveOptions.unindexed`
   * @param foldCase see `ResolveOptions.foldCase`
   */
  constructor(
    assets: readonly Asset[],
    unindexed: ((path: string) => string | null) | undefined,
    foldCase: boolean,
  ) {
    this.foldCase = foldCase;
    const byPath = new Map<string, string>();
    for (const asset of assets) byPath.set(this.keyOf(toPosix(asset.path)), asset.path);
    this.byPath = byPath;
    this.ordered = [...byPath.keys()].sort(compareStrings);
    this.unindexed = unindexed ?? (() => null);
  }

  private keyOf(path: string): string {
    return this.foldCase ? path.toLowerCase() : path;
  }

  /** The file a literal path names, or `null`. */
  lookup(
    path: string,
    raw: RawReference,
    root: string,
    publicDirs: readonly string[],
  ): Candidate | null {
    for (const candidate of candidatePaths(path, raw, root, publicDirs)) {
      const match = this.lookupExact(candidate.path);
      if (match !== null) return { path: match, via: candidate.via };
    }
    return null;
  }

  /**
   * The asset, or else the unindexed file, at an already-absolute POSIX path, or `null`. An
   * expanded alias is already complete, its base taken from the config, so it skips the
   * candidates `lookup` builds.
   */
  lookupExact(path: string): string | null {
    return this.byPath.get(this.keyOf(path)) ?? this.unindexed(path);
  }

  /**
   * Every asset a template pattern names. All of them: linking only the first would leave
   * the rest looking unreferenced, a false `dead` finding.
   */
  matchPattern(
    rawPath: string,
    raw: RawReference,
    root: string,
    publicDirs: readonly string[],
  ): { matches: readonly string[]; via: ResolvedVia } {
    for (const candidate of candidatePaths(withHoles(rawPath), raw, root, publicDirs)) {
      const matches = this.matchGlob(candidate.path);
      // The provenance has to be the candidate that actually matched, so the
      // matches and the `via` cannot disagree about which base was used.
      if (matches.length > 0) return { matches, via: candidate.via };
    }

    return { matches: [], via: 'file' };
  }

  /** Every asset an absolute POSIX path with holes names, anchored at both ends. */
  matchGlob(pathWithHoles: string): readonly string[] {
    const matches: string[] = [];
    const pattern = globRegex(pathWithHoles, false, this.foldCase);
    for (const assetPath of this.ordered) {
      if (!pattern.test(assetPath)) continue;
      const native = this.byPath.get(assetPath);
      if (native !== undefined && !matches.includes(native)) matches.push(native);
    }
    return matches;
  }
}

/** One place a path might live, and how the engine got there. */
interface Candidate {
  readonly path: string;
  readonly via: ResolvedVia;
}

/**
 * Where a path might live, in the order the candidates are tried.
 *
 * A relative path resolves against the referencing file. A root-relative one is tried
 * against each serving root whose app directory is an ancestor of the file, nearest first
 * (see `servingRootsFor`), then against the project root, where a plain static site serves
 * `/hero.png` from. A Windows drive path is absolute, and has a candidate only inside the
 * project. See "The resolver's seven outcomes" in ARCHITECTURE.md.
 */
function candidatePaths(
  path: string,
  raw: RawReference,
  root: string,
  publicDirs: readonly string[],
): readonly Candidate[] {
  if (isDrivePath(path)) {
    const inside = drivePathInProject(path, root);
    return inside === null ? [] : [{ path: inside, via: 'file' }];
  }

  if (!path.startsWith('/')) {
    const relative: Candidate[] = [
      { path: toPosix(resolvePath(dirname(raw.file), path)), via: 'file' },
    ];

    // Speculative references only. In every module system `./` means file-relative, so a
    // project-root fallback on an asserted `import './missing.png'` could link a broken
    // import to an unrelated file. A path-shaped string in a data object is already a
    // guess, and the code may well join it to the project root, as astro-docs does. The
    // match is recorded as `speculative-root`: it keeps the asset alive, and its text is
    // never rewritten.
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

  // The project root, tried last. A plain static site really does serve `/hero.png`
  // from here, but when serving roots were named and none held the path this is a
  // fallback rather than a statement, which is why it is recorded as `project-root`.
  add({ path: toPosix(resolvePath(root, withoutLeadingSlash)), via: 'project-root' });
  return candidates;
}

/**
 * A drive path read by Windows rules (`..` collapsed, either slash a separator) and written
 * with `/`, as the asset index spells paths. The same on every platform, so a report made
 * on Linux says what one made on Windows does.
 */
function posixDrivePath(path: string): string {
  return win32.resolve(path).replaceAll('\\', '/');
}

/**
 * How the asset index spells a drive path that lies inside the project, or `null` when it
 * lies outside. Windows compares paths without regard to case, so the project root's part
 * is matched that way and then spelled as the root spells it; the rest keeps its case, as
 * a relative path's does.
 */
function drivePathInProject(path: string, root: string): string | null {
  const absolute = posixDrivePath(path);
  const projectRoot = toPosix(resolvePath(root)).replace(/\/$/, '');
  if (!absolute.toLowerCase().startsWith(`${projectRoot.toLowerCase()}/`)) return null;
  return `${projectRoot}${absolute.slice(projectRoot.length)}`;
}

/** `./a/b.png` -> `a/b.png`, leaving `../` alone: that really is file-relative. */
function stripDotSlash(path: string): string {
  return path.startsWith('./') ? path.slice(2) : path;
}

/**
 * The serving roots that could serve this file, nearest first.
 *
 * Only ancestors: a serving root's app directory is its parent (`apps/v4/public` belongs to
 * `apps/v4`), and a file outside that app is not served by it. A monorepo's roots serve
 * different URL spaces, so trying them all would link one app's reference to another app's
 * asset, and a rewrite would then point it at a file its app does not serve. A top-level
 * root such as `public` belongs to the project root, so it applies to every file.
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
 * A pattern's path as the resolver globs it: every interpolation a hole, and any query or
 * fragment removed.
 */
function withHoles(rawPath: string): string {
  // Every interpolation syntax becomes a hole, not only JavaScript's `${…}`: a SCSS
  // `#{$mode}` left in place would be globbed literally and match nothing.
  let marked = rawPath;
  for (const interpolation of INTERPOLATIONS) marked = marked.replace(interpolation, HOLE);
  return splitPathSuffix(marked).path;
}

/**
 * Whether a root-relative pattern could name an asset from a serving root the run did not
 * find.
 *
 * `matchPattern` anchors its glob at each serving root it was given and then at the project
 * root. A run that could not find its serving root globs against the wrong directories, so
 * the pattern ends `dynamic` while the files it names sit on disk. This is the same glob
 * with the serving root left open: the pattern has to match the end of an asset's path, in
 * whole segments, so every directory it fixes must be there. Case is ignored, as the
 * audit's sweep ignores it everywhere, because Windows does.
 *
 * @param pattern A root-relative path with holes, as the reference's text proves it.
 * @returns A test of an asset's POSIX path relative to the project root.
 * @example
 * const couldName = servedFromAnyRoot('/img/pattern-${n}.png');
 * couldName('src/img/pattern-1.png'); // true
 * couldName('src/pattern-1.png'); // false: the pattern fixes `img/`
 */
export function servedFromAnyRoot(pattern: string): (relative: string) => boolean {
  const path = posix.normalize(withHoles(pattern));
  const glob = globRegex(path.startsWith('/') ? path.slice(1) : path, true);
  return (relative) => glob.test(relative);
}

/**
 * Turn a resolved path containing holes into an anchored regular expression.
 *
 * A hole becomes `[^/]*`: it matches within one path segment, so
 * `` `/img/${name}.png` `` cannot reach into a subdirectory and pull in assets the
 * author never meant. Everything else is escaped literally. With `openBase`, any
 * directories may come before the path and case is ignored, for `servedFromAnyRoot`.
 * `ignoreCase` ignores it with a fixed base too, for an index that folds case.
 */
function globRegex(pathWithHoles: string, openBase = false, ignoreCase = openBase): RegExp {
  const escaped = pathWithHoles
    .split(HOLE)
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
  const flags = ignoreCase ? 'i' : '';
  return new RegExp(openBase ? `^(?:.*/)?${escaped}$` : `^${escaped}$`, flags);
}
