/**
 * Move an asset and repoint every reference that names it.
 *
 * The engine half of `upfly move` (§1.2). **Renaming and moving are the same
 * operation** — an asset's path changed — so there is one mechanism, and a single-file
 * move is the simple case of a folder move.
 *
 * Pure, like `plan.ts`: it reads a graph and returns decisions. Nothing here touches a
 * disk. The decisions ride the same transaction and manifest as `optimize`, so `undo`
 * covers a move for free.
 *
 * ⚠️ **R39 governs this module more than any rule in the phase, and it is why
 * `relocate` was built last rather than first.** A move acts on **what the graph
 * knows**. A reference the graph *missed* becomes a dangling reference **we caused**,
 * not one we found — and R26 measured a 16% false-`dead` rate on a real repository
 * before its fix. The same engine that finds a problem can manufacture it at scale the
 * moment it starts writing. Every refusal below is cheaper than that.
 *
 * 🔴 **R70 is the shape of this module.** Three questions were open before it was
 * built and **two of them turned out to be one**: an alias cannot express a path
 * outside its own root, and a root-relative URL only works inside a served directory.
 * Both are the same event — the asset crossed the boundary between **bundler-managed**
 * and **served directly** — and that changes the *mechanism* of reference rather than
 * the path:
 *
 * | where it lives | how code refers to it | what resolves it |
 * |---|---|---|
 * | `src/assets/hero.png` | `import hero from '~/assets/hero.png'` | the bundler — hashes it, emits it |
 * | `public/img/hero.png` | `<img src="/img/hero.png">` | the web server — serves the bytes verbatim |
 *
 * **Turning one into the other is a code change, not a path rewrite.** An import
 * statement would have to become a URL string, or the reverse. **`relocate` rewrites
 * paths. It does not rewrite code.** So it refuses, and reports — the shape §1.2
 * already uses for a destination outside the project. A move wholly inside one world
 * proceeds normally.
 */

import type { AliasMap, AliasRule } from './aliases.js';
import type { Graph } from './graph.js';
import type { Declined } from './manifest.js';
import { compareStrings, relativePath, toPosix } from './paths.js';
import { isUnderPublicDir } from './plan.js';
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
 * Why a move will not be made.
 *
 * ⚠️ **A refusal is a first-class outcome, not an error.** §1.2 settled that for a
 * destination outside the project — *"N references will break, here they are"* — and
 * every code here is the same family: **some destinations are not path changes.**
 * Saying nothing would be the silent-skip failure (rule 9) in a new costume.
 */
export type RefusalCode =
  /** The destination is not inside the project, so we cannot rewrite what reaches it. */
  | 'outside-project'
  /**
   * The asset would cross between bundler-managed and served-directly (R70 a and b).
   *
   * The single most important refusal in this module, and the one a reader is most
   * likely to think is over-cautious. It is not: after this move there is no path text
   * that reaches the file, whatever we write.
   */
  | 'crosses-serving-boundary'
  /**
   * A pattern reference binds this asset together with others that are not moving.
   *
   * R70(c), inheriting R65. A pattern is one edit over N assets, so moving some and
   * not others breaks it — and **moving all N silently is not the fix, because the
   * user asked for one file.**
   */
  | 'binds-a-pattern'
  /** Something is already at the destination, so the move would destroy it. */
  | 'destination-occupied'
  /** Two moves in one request target the same destination. */
  | 'destination-claimed-twice'
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
   * References that name a moved asset and could not be repointed.
   *
   * 🔴 **These are the ones R39 is about.** The move still happens — the other
   * references are repointed and the file is where the user asked for it — but a
   * reference we could not edit is a reference that will break, and it is named here
   * rather than left to be discovered. An unsafe or template reference cannot be
   * rewritten by replacing path text, and a dynamic one has no path text at all.
   */
  readonly declined: readonly Declined[];
}

export interface RelocateInput {
  readonly graph: Graph;
  /** What the user asked for. Order does not matter; output is sorted. */
  readonly moves: readonly Move[];
  readonly servingRoots: ServingRoots;
  /** POSIX-relative, or null when the project serves nothing publicly. */
  readonly publicDir: string | null;
  /**
   * The aliases the resolver used, so an aliased reference can be re-expressed.
   *
   * ⚠️ **Required, not optional, and `{}` is a real answer.** The graph does not record
   * that a reference came through an alias — `resolvedVia` says `file` either way — so
   * without this an aliased path would be re-derived as though it were relative, which
   * produces text that resolves to nothing and looks perfectly reasonable. A caller
   * that genuinely has no aliases passes an empty map and says so.
   */
  readonly aliases: AliasMap;
  readonly rootLinkPolicy?: RootLinkPolicy;
}

/** Which half of the world an asset lives in. The distinction R70 turns on. */
type World = 'served' | 'bundled';

/**
 * Plan a set of moves. Pure; refuses rather than guessing.
 *
 * Nothing partially applies: a refused move contributes no rewrites, so a caller that
 * ignores `refused` writes nothing wrong — it simply writes less than it asked for.
 */
export function planRelocation(input: RelocateInput): RelocationPlan {
  const refused: RefusedMove[] = [];
  const declined: Declined[] = [];
  const byRelative = assetIndex(input.graph);
  const accepted = new Map<string, Move>();
  const claimed = new Map<string, string>();

  for (const move of [...input.moves].sort((a, b) => compareStrings(a.from, b.from))) {
    const refusal = refuse(move, input, byRelative, claimed);
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
): RefusedMove | null {
  const say = (code: RefusalCode, reason: string): RefusedMove => ({ ...move, code, reason });

  if (!byRelative.has(move.from)) {
    return say(
      'not-an-asset',
      `${move.from} is not an asset in this project, so Upfly cannot know what points at it.`,
    );
  }

  // A destination that climbs out of the root, on either separator. Checked on the
  // text rather than by resolving, because a caller hands us project-relative paths
  // and a path that escapes them is a request we cannot honour rather than a file we
  // should go looking for.
  const to = toPosix(move.to);
  if (to.startsWith('/') || to.startsWith('../') || to === '..' || /^[a-zA-Z]:/.test(move.to)) {
    return say(
      'outside-project',
      `${move.to} is outside this project. Upfly can only rewrite references to files it can see, so every reference to ${move.from} would break.`,
    );
  }

  const previous = claimed.get(to.toLowerCase());
  if (previous !== undefined) {
    // Case-insensitively, because two destinations differing only in case are one file
    // on Windows and macOS. The same fold `prepare` applies, for the same reason.
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

  // 🔴 R70(a) and (b), which are one test because they are one event.
  const from = worldOf(move.from, input.publicDir);
  const into = worldOf(to, input.publicDir);
  if (from !== into) {
    return say('crosses-serving-boundary', crossingReason(move, from));
  }

  const bound = patternSiblings(move.from, input.graph);
  if (bound !== null) {
    return say('binds-a-pattern', bound);
  }

  // R70(a) again, in its narrow form: within the bundler world an alias still has to
  // be able to *say* the new path. `~/assets/*` cannot express `src/lib/x.png`.
  const inexpressible = aliasCannotExpress(move, input);
  if (inexpressible !== null) {
    return say('crosses-serving-boundary', inexpressible);
  }

  return null;
}

/**
 * Which world an asset lives in.
 *
 * Reuses the audit's own predicate rather than restating it, because the `''` case —
 * a project that serves from its own root, so **every** asset is served — has been got
 * backwards twice already in two different modules. A third copy would be a third
 * chance.
 */
function worldOf(relative: string, publicDir: string | null): World {
  return isUnderPublicDir(relative, publicDir) ? 'served' : 'bundled';
}

function crossingReason(move: Move, from: World): string {
  const detail =
    from === 'bundled'
      ? `${move.from} is bundler-managed: code imports it and the build emits it. ${move.to} is served directly, where a browser asks for it by URL.`
      : `${move.from} is served directly, where a browser asks for it by URL. ${move.to} is bundler-managed: code would have to import it and the build would emit it.`;

  return `${detail} Moving it changes how the file is referenced, not just where it lives, so an import would have to become a URL or the reverse. Upfly rewrites paths, not code. Move it within ${from === 'bundled' ? 'the source tree' : 'the served directory'}, or change the references by hand first.`;
}

/**
 * R70(c): the assets a pattern binds to this one, or `null` when none does.
 *
 * A template reference is **one edit standing for N assets**, so moving one of them
 * breaks it for all N. ⚠️ **Moving all N instead is not the fix** — the user asked for
 * one file, and silently taking the others with it is the kind of help nobody asked
 * for. Naming them is what makes the refusal actionable.
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
 * Whether some alias names the old path but none can name the new one.
 *
 * `astro-docs` imports `~/assets/houston.png` through `~/* → src/*`. Move that file to
 * a directory no target of that rule covers and **no alias path reaches it** — the
 * reference cannot be re-spelled, only rewritten into a different kind of reference,
 * which is the code change R70 refuses.
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
 * ⚠️ **Scope is checked, not just the prefix.** A rule only applies to references from
 * inside the directory its config governs — `expandAlias` enforces that, and a matcher
 * here that looked only at the prefix would claim a `~/` reference in a file the rule
 * does not cover. It would then re-spell that reference through an alias the resolver
 * never used, producing text that looks right and reaches nothing. The same condition
 * as `aliases.ts`, spelled the same way.
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
 * The same three tests `plan.ts` applies before repointing a converted asset. They are
 * restated rather than shared because the *sentences* differ — one is about a
 * conversion and one about a move — but the conditions must not drift, and a change to
 * either belongs in both.
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
 * The new text for one reference, **as expressed from the file that holds it**.
 *
 * A root-relative reference stays root-relative, a relative one is re-derived from the
 * referencing file's directory, an aliased one keeps its alias — and the original
 * spelling survives, because a diff full of `./` appearing and disappearing is a diff
 * nobody can review.
 */
function repointed(reference: Reference, move: Move, input: RelocateInput): string | null {
  const { rawPath } = reference;
  const suffix = rawPath.slice(pathPartOf(rawPath).length);
  const path = pathPartOf(rawPath);

  const rule = aliasRuleFor(path, toPosix(reference.file), input.aliases);
  if (rule !== null) {
    const aliased = aliasTextFor(rule, move.to, input.graph.root);
    return aliased === null ? null : `${aliased}${suffix}`;
  }

  if (reference.resolution === 'resolved' && reference.resolvedVia === 'serving-root') {
    const base = servingRootFor(move.to, input.servingRoots);
    if (base === null) return null;
    const rest = base === '' ? move.to : move.to.slice(base.length + 1);
    return `/${rest}${suffix}`;
  }

  if (reference.resolution === 'resolved' && reference.resolvedVia === 'project-root') {
    return `/${move.to}${suffix}`;
  }

  const from = directoryOf(toPosix(relativePath(input.graph.root, reference.file)));
  const relative = posixRelative(from, move.to);
  // `./` is kept when the original had it and not invented when it did not, so the
  // edit changes the path and nothing else about the line.
  const dotted = path.startsWith('./') && !relative.startsWith('../') ? `./${relative}` : relative;
  return `${dotted}${suffix}`;
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
