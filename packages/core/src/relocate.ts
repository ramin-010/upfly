/**
 * Move an asset and repoint every reference that names it.
 *
 * Renaming and moving are one operation, so a single-file move is the simple case of a
 * folder move. Pure, like `plan.ts`: it reads a graph and returns decisions. The moves ride
 * the same transaction and manifest as `optimize`, so `revert` undoes them too.
 *
 * A move acts on what the graph knows, so a reference the graph missed becomes a broken
 * reference this run caused; every refusal below is cheaper than that. It rewrites paths,
 * not code, so it refuses a move that changes how a file is reached, such as from an
 * import the bundler resolves to a URL a browser requests.
 * See "Moving an asset" in ARCHITECTURE.md.
 */

import { spell } from './adapters/reference-path.js';
import type { AliasMap, AliasRule } from './aliases.js';
import type { Graph } from './graph.js';
import type { Declined } from './manifest.js';
import { compareStrings, relativePath, toPosix } from './paths.js';
import { servingRootOf } from './plan.js';
import type { PlannedRewrite, RootLinkPolicy } from './plan.js';
import { isLinked, linkedPaths } from './reference.js';
import type { ServingRoots } from './resolve.js';
import type { Edit, Reference } from './types.js';

/** One asset's path change. Both sides POSIX-relative to the project root. */
export interface Move {
  readonly from: string;
  readonly to: string;
}

/**
 * Why a move will not be made. A refusal is an outcome, not an error: the move is
 * reported with its reason rather than dropped.
 */
export type RefusalCode =
  /** The destination is not inside the project, so we cannot rewrite what reaches it. */
  | 'outside-project'
  /**
   * The move would change how the file is reached, not only its path: between the bundled
   * source tree and a served directory, between two serving roots, or out of reach of the
   * alias an import uses.
   */
  | 'crosses-serving-boundary'
  /**
   * A pattern reference matches this asset and others. The pattern is one piece of text
   * for all of them, so moving one breaks it; moving the rest too is not the fix, because
   * the user asked for one file.
   */
  | 'binds-a-pattern'
  /** An asset is already at the destination, so the move would destroy it. */
  | 'destination-occupied'
  /** Two moves in one request target the same destination. */
  | 'destination-claimed-twice'
  /** Two moves in one request move the same file to different places. */
  | 'source-claimed-twice'
  /** The asset is not in the graph, so we cannot know what points at it. */
  | 'not-an-asset';

export interface RefusedMove {
  readonly from: string;
  readonly to: string;
  readonly code: RefusalCode;
  /** A sentence a user can act on, naming what is in the way. */
  readonly reason: string;
}

export interface RelocationPlan {
  /** The moves that will be made, in path order. */
  readonly moves: readonly Move[];
  /** The edits that keep every reference pointing at the moved asset. */
  readonly rewrites: readonly PlannedRewrite[];
  /** Moves not made, each with its reason. */
  readonly refused: readonly RefusedMove[];
  /**
   * References to a moved asset that could not be repointed, and why. The move still
   * happens and the other references follow it; each of these will break, so it is named
   * here rather than left to be found.
   */
  readonly declined: readonly Declined[];
}

export interface RelocateInput {
  readonly graph: Graph;
  /** What the user asked for. Order does not matter; output is sorted. */
  readonly moves: readonly Move[];
  /** The serving roots the resolver used. An asset under any of them is served. */
  readonly servingRoots: ServingRoots;
  /**
   * The aliases the resolver used, so an aliased import can be re-spelled through its alias.
   *
   * Required, so forgetting it cannot pass for having none: the graph does not record that
   * a reference came through an alias (`resolvedVia` is `serving-root`, as for a URL), and
   * without the aliases an aliased import would be re-spelled as a URL or declined. A
   * caller with no aliases passes an empty map.
   */
  readonly aliases: AliasMap;
  readonly rootLinkPolicy?: RootLinkPolicy;
}

/**
 * Plan a set of moves, refusing any it cannot make safely rather than guessing.
 *
 * A refused move contributes no rewrites, so a caller that ignores `refused` writes
 * nothing wrong, only less than it asked for.
 */
export function planRelocation(input: RelocateInput): RelocationPlan {
  const refused: RefusedMove[] = [];
  const declined: Declined[] = [];
  const byRelative = assetIndex(input.graph);
  const accepted = new Map<string, Move>();
  const claimed = new Map<string, string>();

  for (const move of [...input.moves].sort((a, b) => compareStrings(a.from, b.from))) {
    const refusal = refuse(move, input, byRelative, claimed, accepted);
    if (refusal !== null) {
      refused.push(refusal);
      continue;
    }
    claimed.set(move.to.toLowerCase(), move.from);
    accepted.set(move.from, move);
  }

  const edits = new Map<string, Edit[]>();
  for (const reference of input.graph.references) {
    collectRepoint(reference, accepted, input, edits, declined);
  }

  return {
    moves: [...accepted.values()],
    rewrites: [...edits.entries()]
      .map(([file, list]) => ({ file, edits: [...list].sort((a, b) => a.start - b.start) }))
      .sort((a, b) => compareStrings(a.file, b.file)),
    refused,
    declined: declined.sort(
      (a, b) => compareStrings(a.path, b.path) || compareStrings(a.reason, b.reason),
    ),
  };
}

/** Assets by POSIX-relative path, which is how a move names them. */
function assetIndex(graph: Graph): Map<string, string> {
  const index = new Map<string, string>();
  for (const node of graph.assets) index.set(node.asset.relative, node.asset.path);
  return index;
}

/** Why this move will not be made, or `null` when it will. */
function refuse(
  move: Move,
  input: RelocateInput,
  byRelative: ReadonlyMap<string, string>,
  claimed: ReadonlyMap<string, string>,
  accepted: ReadonlyMap<string, Move>,
): RefusedMove | null {
  const say = (code: RefusalCode, reason: string): RefusedMove => ({ ...move, code, reason });

  if (!byRelative.has(move.from)) {
    return say(
      'not-an-asset',
      `${move.from} is not an asset in this project, so Upfly cannot know what points at it.`,
    );
  }

  // A destination that starts outside the root, on either separator. Checked on the text
  // rather than by resolving: the caller hands over project-relative paths, and one that
  // escapes the project is a request Upfly cannot honour, not a file to go looking for.
  const to = toPosix(move.to);
  if (to.startsWith('/') || to.startsWith('../') || to === '..' || /^[a-zA-Z]:/.test(move.to)) {
    return say(
      'outside-project',
      `${move.to} is outside this project. Upfly can only rewrite references to files it can see, so every reference to ${move.from} would break.`,
    );
  }

  const already = accepted.get(move.from);
  if (already !== undefined) {
    return say(
      'source-claimed-twice',
      `${move.from} is already being moved to ${already.to}, so Upfly cannot also move it to ${move.to}.`,
    );
  }

  const previous = claimed.get(to.toLowerCase());
  if (previous !== undefined) {
    // Case-insensitively, because two destinations differing only in case are one file
    // on Windows and macOS. `prepare` folds case for the same reason.
    return say(
      'destination-claimed-twice',
      `${previous} is already being moved to ${move.to}, so this move would depend on which ran first.`,
    );
  }

  if (byRelative.has(to) && to !== move.from) {
    return say(
      'destination-occupied',
      `${move.to} already exists. Moving ${move.from} onto it would destroy a file Upfly can see.`,
    );
  }

  // One test for both directions between bundled and served, and for a move between two
  // serving roots: in each, the way the file is reached changes.
  const from = servingRootOf(move.from, input.servingRoots);
  const into = servingRootOf(to, input.servingRoots);
  if (from !== into) {
    return say('crosses-serving-boundary', crossingReason(move, from, into));
  }

  const bound = patternSiblings(move.from, input.graph);
  if (bound !== null) {
    return say('binds-a-pattern', bound);
  }

  // Within the bundled world an alias still has to be able to spell the new path:
  // `~/assets/*` cannot express `src/lib/x.png`.
  const inexpressible = aliasCannotExpress(move, input);
  if (inexpressible !== null) {
    return say('crosses-serving-boundary', inexpressible);
  }

  return null;
}

/**
 * Why a move that changes where the file is served from is refused. `null` is the bundled
 * world: code imports the file and the build emits it.
 */
function crossingReason(move: Move, from: string | null, into: string | null): string {
  if (from !== null && into !== null) {
    return `${move.from} is served from ${rootName(from)} and ${move.to} would be served from ${rootName(into)}, so a URL that finds it today would not find it there. Move it within ${rootName(from)}, or change the references by hand first.`;
  }
  const detail =
    from === null
      ? `${move.from} is bundler-managed: code imports it and the build emits it. ${move.to} is served directly, where a browser asks for it by URL.`
      : `${move.from} is served directly, where a browser asks for it by URL. ${move.to} is bundler-managed: code would have to import it and the build would emit it.`;

  return `${detail} Moving it changes how the file is referenced, not just where it lives, so an import would have to become a URL or the reverse. Upfly rewrites paths, not code. Move it within ${from === null ? 'the source tree' : 'the served directory'}, or change the references by hand first.`;
}

/** A serving root as a sentence names it. */
function rootName(root: string): string {
  return root === '' ? 'the project root' : `${root}/`;
}

/**
 * Why moving this asset alone would break a pattern, naming the other assets it matches,
 * or `null` when no pattern binds this asset to another.
 *
 * A template reference is one piece of text standing for N assets, so moving one breaks
 * it for all N. Moving the others as well is not the fix: the user asked for one file.
 */
function patternSiblings(relative: string, graph: Graph): string | null {
  for (const reference of graph.references) {
    if (reference.resolution !== 'resolved-pattern') continue;

    const bound = reference.resolvedPaths.map((path) => toPosix(relativePath(graph.root, path)));
    if (!bound.includes(relative)) continue;

    const others = bound.filter((path) => path !== relative).sort(compareStrings);
    if (others.length === 0) continue;

    return `Moving ${relative} alone would break \`${reference.rawPath}\`, which also matches ${others.join(', ')}. Move all ${bound.length}, or none.`;
  }
  return null;
}

/**
 * The refusal when some alias names the old path but none can name the new one, or `null`.
 *
 * `astro-docs` imports `~/assets/houston.png` through `~/* → src/*`. Moved to a directory
 * no target of that rule covers, the file is reached by no alias path: the import could
 * only become a different kind of reference, which this module does not do.
 */
function aliasCannotExpress(move: Move, input: RelocateInput): string | null {
  const root = input.graph.root;

  for (const reference of input.graph.references) {
    if (!isLinked(reference)) continue;
    const targets = linkedPaths(reference).map((path) => toPosix(relativePath(root, path)));
    if (!targets.includes(move.from)) continue;

    const rule = aliasRuleFor(reference.rawPath, toPosix(reference.file), input.aliases);
    if (rule === null) continue;
    if (aliasTextFor(rule, move.to, root) !== null) continue;

    return `\`${reference.rawPath}\` reaches ${move.from} through the \`${rule.prefix}\` alias, and that alias cannot express ${move.to}. The import would have to become a different kind of reference, and Upfly rewrites paths, not code.`;
  }
  return null;
}

/**
 * The alias rule this reference goes through, or `null` when it is not aliased.
 *
 * Scope is checked as well as the prefix, with the same condition as `expandAlias`: a rule
 * applies only to references from inside the directory its config governs. Matching the
 * prefix alone would re-spell a `~/` reference through an alias the resolver never used,
 * producing text that looks right and reaches nothing.
 */
function aliasRuleFor(rawPath: string, file: string, aliases: AliasMap): AliasRule | null {
  for (const rule of aliases.rules) {
    const matches = rule.wildcard ? rawPath.startsWith(rule.prefix) : rawPath === rule.prefix;
    if (!matches) continue;
    if (!file.startsWith(`${rule.scope}/`) && file !== rule.scope) continue;
    return rule;
  }
  return null;
}

/** The aliased spelling of a new path under this rule, or `null` if it has none. */
function aliasTextFor(rule: AliasRule, newRelative: string, root: string): string | null {
  if (!rule.wildcard) return null;

  for (const target of rule.targets) {
    const base = toPosix(relativePath(root, target));
    // `''` is a target at the project root, under which every path sits.
    const inside = base === '' || newRelative === base || newRelative.startsWith(`${base}/`);
    if (!inside) continue;
    const rest = base === '' ? newRelative : newRelative.slice(base.length + 1);
    return `${rule.prefix}${rest}`;
  }
  return null;
}

/** Repoint one reference, or record why it cannot be repointed. */
function collectRepoint(
  reference: Reference,
  accepted: ReadonlyMap<string, Move>,
  input: RelocateInput,
  edits: Map<string, Edit[]>,
  declined: Declined[],
): void {
  const root = input.graph.root;
  const file = toPosix(relativePath(root, reference.file));

  if (!isLinked(reference)) return;
  const targets = linkedPaths(reference).map((path) => toPosix(relativePath(root, path)));
  const moved = targets.filter((target) => accepted.has(target));
  if (moved.length === 0) return;

  // A pattern that binds a moved asset should already have been refused, so reaching
  // here means the pattern binds exactly the one asset that moved. Its text is still a
  // template rather than a path, so it cannot be repointed by replacing text.
  if (reference.resolution === 'resolved-pattern') {
    declined.push({
      path: file,
      line: null,
      reason: `a template reference is assembled at runtime, so its text cannot be repointed after ${moved.join(', ')} moved`,
    });
    return;
  }

  const refusal = rewriteRefusalFor(reference, input);
  if (refusal !== null) {
    declined.push({
      path: file,
      line: null,
      reason: `${refusal}, so ${moved.join(', ')} moved without this reference following it`,
    });
    return;
  }

  const move = accepted.get(targets[0] ?? '');
  if (move === undefined) return;

  const replacement = repointed(reference, move, input);
  if (replacement === null) {
    declined.push({
      path: file,
      line: null,
      reason: `Upfly could not work out how to spell ${move.to} from this reference, so ${move.from} moved without it following`,
    });
    return;
  }
  if (replacement === reference.rawPath) return;

  const list = edits.get(file) ?? [];
  list.push({ start: reference.start, end: reference.end, replacement });
  edits.set(file, list);
}

/**
 * Why this reference may not be edited, or `null` when it may.
 *
 * The same tests and sentences as `rewriteRefusal` in `plan.ts`; each caller adds its own
 * ending. The conditions must not drift, so a change to either belongs in both.
 */
function rewriteRefusalFor(
  reference: Extract<Reference, { resolution: 'resolved' | 'resolved-pattern' }>,
  input: RelocateInput,
): string | null {
  if (reference.confidence === 'unsafe') return 'the reference has no static path to replace';
  if (reference.resolvedVia === 'speculative-root') {
    return 'the path is a guess that happened to resolve against the project root, which shows the asset is alive but not that this text may be edited';
  }
  if (reference.resolvedVia === 'project-root') {
    const policy = input.rootLinkPolicy ?? 'when-no-serving-root';
    if (policy === 'never' || (policy === 'when-no-serving-root' && input.servingRoots.declared)) {
      return 'the path is root-relative and missed the configured serving root, so its existing at the project root may be coincidence rather than a link';
    }
  }
  return null;
}

/**
 * The new text for one reference, as expressed from the file that holds it.
 *
 * A root-relative reference stays root-relative, a relative one is re-derived from the
 * referencing file's directory, and an aliased one keeps its alias. The original spelling
 * survives too, because a diff full of `./` appearing and disappearing is a diff nobody
 * can review.
 */
function repointed(reference: Reference, move: Move, input: RelocateInput): string | null {
  const { rawPath } = reference;
  const suffix = rawPath.slice(pathPartOf(rawPath).length);
  const path = pathPartOf(rawPath);

  // Every return below builds the new text from `move.to`, an on-disk path, so it is
  // re-encoded the way the author wrote the old one: a file named `hero image.png` is
  // written `hero%20image.png` in HTML, and a raw space would break the reference. The
  // spelling comes from `reference.spelling`, not from `rawPath`, because `enc%20name.png`
  // can be a file's real name or an encoding of `enc name.png`, and only the resolver's
  // lookup knows which one matched.
  const spelling =
    reference.resolution === 'resolved' ? (reference.spelling ?? 'literal') : 'literal';
  const asWritten = (target: string): string => spell(target, spelling);

  const rule = aliasRuleFor(path, toPosix(reference.file), input.aliases);
  if (rule !== null) {
    const aliased = aliasTextFor(rule, move.to, input.graph.root);
    return aliased === null ? null : `${asWritten(aliased)}${suffix}`;
  }

  if (reference.resolution === 'resolved' && reference.resolvedVia === 'serving-root') {
    const base = servingRootFor(move.to, input.servingRoots);
    if (base === null) return null;
    const rest = base === '' ? move.to : move.to.slice(base.length + 1);
    return `/${asWritten(rest)}${suffix}`;
  }

  if (reference.resolution === 'resolved' && reference.resolvedVia === 'project-root') {
    return `/${asWritten(move.to)}${suffix}`;
  }

  const from = directoryOf(toPosix(relativePath(input.graph.root, reference.file)));
  const relative = posixRelative(from, move.to);
  // `./` is kept when the original had it and not invented when it did not, so the
  // edit changes the path and nothing else about the line.
  const dotted = path.startsWith('./') && !relative.startsWith('../') ? `./${relative}` : relative;
  return `${asWritten(dotted)}${suffix}`;
}

/** The serving root the new path sits under, or `null` when none does. */
function servingRootFor(relative: string, servingRoots: ServingRoots): string | null {
  for (const dir of servingRoots.dirs) {
    if (dir === '') return '';
    if (relative === dir || relative.startsWith(`${dir}/`)) return dir;
  }
  return null;
}

/** The path part of a raw reference, without any `?query` or `#fragment`. */
function pathPartOf(rawPath: string): string {
  const cut = rawPath.search(/[?#]/);
  return cut === -1 ? rawPath : rawPath.slice(0, cut);
}

/** The directory holding a POSIX-relative file, or `''` at the project root. */
function directoryOf(relative: string): string {
  const cut = relative.lastIndexOf('/');
  return cut === -1 ? '' : relative.slice(0, cut);
}

/** `to`, expressed from `from`. Both POSIX-relative to the project root. */
function posixRelative(from: string, to: string): string {
  const fromParts = from === '' ? [] : from.split('/');
  const toParts = to.split('/');

  let shared = 0;
  while (
    shared < fromParts.length &&
    shared < toParts.length &&
    fromParts[shared] === toParts[shared]
  ) {
    shared += 1;
  }

  const up = fromParts.length - shared;
  const down = toParts.slice(shared);
  return [...Array.from({ length: up }, () => '..'), ...down].join('/');
}

/** Everything the transaction needs to carry out an accepted move. */
export function moveOperationsFor(plan: RelocationPlan, hashOf: (relative: string) => string) {
  return plan.moves.map((move) => ({
    kind: 'move' as const,
    from: move.from,
    to: move.to,
    hash: hashOf(move.from),
  }));
}
