/**
 * Deciding what to convert and which references to repoint.
 *
 * Pure: it reads a graph and a set of measurements and returns decisions. Nothing here
 * touches a disk or encodes anything, so a wrong decision shows in a test before it is a
 * written byte.
 *
 * A reference is rewritten only when Upfly can prove where it points and how it is
 * spelled. Everything declined leaves with a reason, because a skip nobody is told about
 * cannot be told apart from a decision nobody made.
 */

import type { AssetNode, Graph } from './graph.js';
import type { Declined } from './manifest.js';
import { compareStrings, extensionOf, relativePath, toPosix } from './paths.js';
import type { AssetProbe, EncodeFormat, EncodeSetting } from './probe.js';
import { isLinked, linkedPaths } from './reference.js';
import { resolutionHealth } from './resolution-health.js';
import type { ServingRoots } from './resolve.js';
import type { Edit, Reference } from './types.js';

/** What happens to the original when a public asset is converted. */
export type PublicPolicy =
  /** Write the converted file alongside and leave the original in place. */
  | 'keep-original'
  /**
   * Convert an asset only when this run moves at least one reference to the new file,
   * and remove the original only when it moves every reference that links to it.
   *
   * An asset no reference would move to is declined with a reason, so `replace` never
   * writes a copy nobody uses beside an original that has to stay. An original that a
   * pattern or another unmoved reference still needs is kept and listed in
   * `keptOriginals`. See "The transaction" in ARCHITECTURE.md.
   */
  | 'replace';

/**
 * Whether a root-relative path that resolved against the project root may be edited.
 *
 * On a plain static site that is the ordinary case, because there is no serving root to
 * declare. On a project that declares one, the path missed it and happened to exist at
 * the project root, which may be coincidence rather than a link. The default,
 * `when-no-serving-root`, edits such a path only when the project declared no serving
 * root. It keys on the declaration, not on whether the resolver used a root: a detected
 * root is a guess, and declining a link because of a guess is as wrong as trusting a
 * coincidence.
 */
export type RootLinkPolicy = 'when-no-serving-root' | 'always' | 'never';

/**
 * The phrase that marks a decline because a literal mention of the path would survive the
 * rewrite. `report.ts` finds those declines by matching this text to raise a run-level
 * caveat, so the wording lives in one place and the caveat follows any rewording.
 */
export const MENTION_SURVIVES = 'still names its path in a form Upfly cannot rewrite';

export interface PlanInput {
  readonly graph: Graph;
  /** Measurements. An asset with no entry here was never measured. */
  readonly probes: readonly AssetProbe[];
  readonly format: EncodeFormat;
  readonly publicPolicy: PublicPolicy;
  /**
   * Assets nothing links to that a file Upfly could not read mentions by name: the audit's
   * `possibly-dead` findings. Converting one changes a file on disk and rewrites nothing,
   * because no reference Upfly can see points at it.
   */
  readonly hedged: ReadonlySet<string>;
  /**
   * Assets not to convert because a literal mention of their path would survive the
   * rewrite, each mapped to where the mention is (`file:line`, and a count of any others).
   *
   * A surviving mention costs a lost saving and a deleted original costs a broken page, so
   * the asset is declined. `optimize` fills this only for assets whose original the plan
   * would delete: under `keep-original` the original stays and an unrewritten mention still
   * resolves. The search reads files and this module is pure, so `optimize` plans once,
   * searches against that plan, and plans again with this set.
   */
  readonly blockedByMention?: ReadonlyMap<string, string>;
  /**
   * The serving roots the resolver used, carrying whether the project declared them.
   *
   * The same value the resolver was given, not a boolean derived beside it, so the
   * planner cannot be told the project declared a serving root while the resolver
   * resolved against a guess. It is also the planner's only notion of which assets are
   * served: an asset under any of these directories is.
   */
  readonly servingRoots: ServingRoots;
  readonly rootLinkPolicy?: RootLinkPolicy;
}

/** One asset that will be encoded. */
export interface PlannedConversion {
  /** POSIX-relative path of the source. */
  readonly asset: string;
  /** POSIX-relative path the encode will be written to. */
  readonly target: string;
  readonly format: EncodeFormat;
  /**
   * The setting the saving was measured at, and the one the write must use.
   *
   * `'lossless'` is an instruction, not a label: the probe measured the lossless encode
   * smaller than the lossy one. `optimize` passes it to `encodeToFile`, so the file written
   * is the one whose saving was reported.
   */
  readonly quality: EncodeSetting;
  readonly savedBytes: number;
  /**
   * True when the original is removed: under `replace`, a served asset at least one
   * reference links to, every one of which this plan rewrites.
   */
  readonly replacesOriginal: boolean;
}

/** The edits for one source file, already checked for overlap by the caller. */
export interface PlannedRewrite {
  /** POSIX-relative path of the file holding the references. */
  readonly file: string;
  readonly edits: readonly Edit[];
}

/**
 * Why the planner will not act at all.
 *
 * Returned rather than thrown, so the caller holds a finding with a reason: the audit still
 * reports on the repository and only the write path stops. It replaces the per-asset
 * `declined` list: when the engine does not know where files are served from, every asset
 * would decline for the same reason, and one sentence repeated per asset buries it.
 * See "When the serving root cannot be found at all" in ARCHITECTURE.md.
 */
export interface PlanRefusal {
  readonly code: 'serving-root-unknown';
  /** A sentence a user can act on, naming what to do next. */
  readonly reason: string;
  readonly linked: number;
  readonly checkable: number;
}

/**
 * An asset converted under `replace` whose original was left in place, and why.
 *
 * Either the asset is outside a served directory, where the build rather than a browser
 * resolves it, or a reference this run does not rewrite still needs the original, such as
 * a pattern. An asset no reference moves to is not converted under `replace`, so it is
 * never here.
 *
 * Kept apart from `declined`, which the report prints under "Examined and not converted":
 * these assets were converted. An asset is in one list or the other, never both, and
 * `conversions` still holds every conversion.
 */
export interface KeptOriginal {
  /** POSIX-relative path of the asset whose original survives. */
  readonly asset: string;
  /** Why it survives, in a sentence a user can act on. */
  readonly reason: string;
}

export interface OptimizationPlan {
  readonly conversions: readonly PlannedConversion[];
  readonly rewrites: readonly PlannedRewrite[];
  /** Everything the planner decided against, each with the reason it decided. */
  readonly declined: readonly Declined[];
  /**
   * Conversions under `replace` whose original was kept anyway, and why. A user who asked
   * for `replace` is told about every original that stays.
   */
  readonly keptOriginals: readonly KeptOriginal[];
  /**
   * Set when the planner refused to plan anything, and null on an ordinary run.
   *
   * A caller that writes must check this. When it is set, every list in the plan is empty,
   * so a caller that forgets writes nothing rather than something wrong.
   */
  readonly refusal: PlanRefusal | null;
}

/**
 * Every asset a pattern reference could match, as sorted absolute paths.
 *
 * Exposed so the caller can measure exactly these before planning, whatever encode cap
 * is otherwise in force.
 */
export function patternTargets(graph: Graph): readonly string[] {
  const targets = new Set<string>();
  for (const reference of graph.references) {
    if (reference.resolution !== 'resolved-pattern') continue;
    for (const path of reference.resolvedPaths) targets.add(path);
  }
  return [...targets].sort();
}

export function planOptimization(input: PlanInput): OptimizationPlan {
  // Before anything else. Rewriting references on a graph whose root-relative paths
  // did not resolve means repointing whatever did resolve while the majority stays
  // broken, and the engine has no basis for believing either half.
  const health = resolutionHealth(input.graph);
  if (health.servingRootUnknown) {
    return {
      conversions: [],
      rewrites: [],
      declined: [],
      keptOriginals: [],
      refusal: {
        code: 'serving-root-unknown',
        reason: `Only ${health.linked} of ${health.checkable} root-relative references resolved, so Upfly cannot tell where this project serves files from. Declare the directory your site serves from and run again.`,
        linked: health.linked,
        checkable: health.checkable,
      },
    };
  }

  const declined: Declined[] = [];
  const relativeOf = new Map(
    input.graph.assets.map((node) => [node.asset.path, node.asset.relative]),
  );
  const savings = measuredSavings(input);

  const converting = new Map<string, PlannedConversion>();
  for (const node of input.graph.assets) {
    const decision = convertDecision(node, input, savings);
    if (decision.convert) converting.set(node.asset.relative, decision.conversion);
    else if (decision.reason !== null) {
      declined.push({ path: node.asset.relative, line: null, reason: decision.reason });
    }
  }

  // Before everything that asks which assets convert. A literal repointed at a
  // conversion that is withdrawn afterwards names a file that is never written, and a
  // pattern reported as "N of them do not convert" would be counting the wrong N.
  for (const asset of vetoCollisions(input, converting, declined)) converting.delete(asset);

  declinePartialPatterns(input, converting, relativeOf, declined);

  const edits = new Map<string, Edit[]>();
  const rewritten = new Set<Reference>();
  for (const reference of input.graph.references) {
    const moved = collectRewrite(reference, {
      input,
      root: input.graph.root,
      converting,
      relativeOf,
      edits,
      declined,
    });
    if (moved) rewritten.add(reference);
  }

  // Last, because whether an original may go depends on which references this plan
  // rewrites, and that is known only once every reference has been decided.
  const stillNeeded = originalsStillNeeded(input, converting, rewritten);
  const conversions = [...converting.values()].map((conversion) =>
    stillNeeded.has(conversion.asset) ? { ...conversion, replacesOriginal: false } : conversion,
  );

  return {
    conversions: conversions.sort((a, b) => a.asset.localeCompare(b.asset)),
    rewrites: [...edits.entries()]
      .map(([file, list]) => ({ file, edits: [...list].sort((a, b) => a.start - b.start) }))
      .sort((a, b) => a.file.localeCompare(b.file)),
    declined: declined.sort(
      (a, b) => a.path.localeCompare(b.path) || a.reason.localeCompare(b.reason),
    ),
    // Derived from the surviving conversions rather than collected as decisions were
    // made, so an asset `vetoCollisions` withdrew cannot claim a kept original for a file
    // that never converted.
    keptOriginals: keptOriginals(conversions, stillNeeded, input),
    refusal: null,
  };
}

interface Saving {
  readonly savedBytes: number;
  readonly quality: EncodeSetting;
}

/**
 * The measured saving for each asset in the requested format.
 *
 * A measurement that came back no smaller than the source is dropped here: the point of
 * converting is a smaller file, and writing a bigger one makes the repository worse.
 */
function measuredSavings(input: PlanInput): Map<string, Saving> {
  const sizeOf = new Map(input.graph.assets.map((node) => [node.asset.relative, node.asset.bytes]));
  const savings = new Map<string, Saving>();

  for (const probe of input.probes) {
    const original = sizeOf.get(probe.relative);
    if (original === undefined) continue;

    for (const encoded of probe.encoded) {
      if (encoded.format !== input.format) continue;
      const savedBytes = original - encoded.bytes;
      if (savedBytes <= 0) continue;
      savings.set(probe.relative, { savedBytes, quality: encoded.quality });
    }
  }
  return savings;
}

/**
 * Whether this asset was encoded in the target format at all, which separates "measured,
 * nothing to gain" from "never measured". Only the second is reported elsewhere.
 */
function wasMeasured(relative: string, input: PlanInput): boolean {
  const probe = input.probes.find((entry) => entry.relative === relative);
  return probe?.encoded.some((encoded) => encoded.format === input.format) ?? false;
}

type ConvertDecision =
  | { readonly convert: true; readonly conversion: PlannedConversion }
  | { readonly convert: false; readonly reason: string | null };

/**
 * Whether one asset is converted, and why not when it is not.
 *
 * `reason: null` is only for an asset there was no decision to make about, such as one
 * nothing measured, which the audit already reports as a probe skip naming the cap, the
 * vector or the format. An asset measured and found no smaller gets a reason, because
 * nothing else reports it: a `format-opportunity` finding exists only when there is an
 * opportunity, and the audit's skip list holds only measurements that were not taken.
 */
function convertDecision(
  node: AssetNode,
  input: PlanInput,
  savings: ReadonlyMap<string, Saving>,
): ConvertDecision {
  const relative = node.asset.relative;
  const saving = savings.get(relative);
  if (saving === undefined) {
    return wasMeasured(relative, input)
      ? {
          convert: false,
          reason: `measured as ${input.format} and came out no smaller, so converting it would cost bytes rather than save them`,
        }
      : { convert: false, reason: null };
  }

  const target = withExtension(relative, input.format);
  if (target === relative) return { convert: false, reason: null };

  const inPublic = servingRootOf(relative, input.servingRoots) !== null;

  // An asset nothing links to gets no reference repointed, only a new file. Inside a
  // served directory that is still worth it under `keep-original`: something outside the
  // repository may load the asset, and can be pointed at the smaller file later. Outside
  // one it gains only bytes, which do not justify touching a file nothing is known to use.
  // Under `replace` the next check declines the served case too.
  if (node.references.length === 0 && !inPublic) {
    const why = input.hedged.has(relative)
      ? 'nothing links to it and something we could not read mentions it, so converting would change a file whose references we cannot see'
      : noServingRootFound(input.servingRoots)
        ? `nothing links to it, and ${NO_WEBSITE_FOLDER}; converting it would gain only bytes. ${NAME_THE_WEBSITE_FOLDER}`
        : 'nothing links to it, so converting it would rewrite no reference and gain only bytes';
    return { convert: false, reason: why };
  }

  // Under `replace` a new file has to be one some reference moves to; otherwise it sits
  // unused beside an original that must stay. Decided here, before collisions and before
  // any reference is repointed. See "The transaction" in ARCHITECTURE.md.
  if (input.publicPolicy === 'replace') {
    const unused = unusedUnderReplace(node, input);
    if (unused !== null) return { convert: false, reason: unused };
  }

  // A literal mention of the path would outlive the rewrite. `optimize` fills this set only
  // with assets its first plan converted, so none of the checks above declines them here.
  const surviving = input.blockedByMention?.get(relative);
  if (surviving !== undefined) {
    return {
      convert: false,
      // Names where the mention is, so the user does not have to search the repository
      // for a path the search already found.
      reason: `converting it would delete the original, and ${surviving} ${MENTION_SURVIVES}`,
    };
  }

  return {
    convert: true,
    conversion: {
      asset: relative,
      target,
      format: input.format,
      quality: saving.quality,
      savedBytes: saving.savedBytes,
      replacesOriginal: inPublic && input.publicPolicy === 'replace',
    },
  };
}

/**
 * Why one asset in a colliding set is declined, naming everything in its way.
 *
 * Every obstacle, not the first one that matched: a pair that collides with each other and
 * with a file already there is still blocked after one of the pair is renamed, and naming
 * only the pair would send somebody round twice.
 *
 * Assets heading for the identically spelled target share a clause, so a three-way
 * collision stays readable. A target that differs only in case gets its own clause saying
 * why two names are one file, since a reader looking at `Reaktor.webp` and `reaktor.webp`
 * would otherwise conclude the engine is broken.
 */
function collisionReason(
  asset: string,
  colliding: readonly string[],
  existing: string | undefined,
  converting: ReadonlyMap<string, PlannedConversion>,
  key: string,
): string {
  const targetOf = (path: string) => converting.get(path)?.target ?? key;
  const target = targetOf(asset);
  const sameFile = `which is the same file as ${target} on Windows and macOS`;

  const sameSpelling = colliding.filter((other) => other !== asset && targetOf(other) === target);
  const blockers: string[] = [];
  if (sameSpelling.length > 0) {
    blockers.push(`${sameSpelling.join(' and ')} would also convert to ${target}`);
  }
  for (const other of colliding) {
    if (other === asset || targetOf(other) === target) continue;
    blockers.push(`${other} would convert to ${targetOf(other)}, ${sameFile}`);
  }
  if (existing !== undefined) {
    blockers.push(
      existing === target
        ? `${target} already exists`
        : `${existing} already exists, and is the same file as ${target} on Windows and macOS`,
    );
  }

  return `${blockers.join(', and ')}, so converting it would replace a file rather than add one. Rename one of them and run again.`;
}

/**
 * Drop the conversions that would write over each other, or over a file already there.
 *
 * Swapping an extension is not injective: `distance.png` and `distance.gif` both become
 * `distance.webp`, and converting `logo.png` where `logo.webp` exists destroys a file
 * somebody made. Every asset involved is declined, naming the others, because which file
 * should win, or what to rename it to, is the user's choice. Only planned conversions
 * collide: an asset that was never going to convert overwrites nothing. Targets are
 * compared case-insensitively on every platform.
 * See "Two paths are the same file more often than they look" in ARCHITECTURE.md.
 */
function vetoCollisions(
  input: PlanInput,
  converting: ReadonlyMap<string, PlannedConversion>,
  declined: Declined[],
): ReadonlySet<string> {
  const alreadyThere = new Map(
    input.graph.assets.map((node) => [node.asset.relative.toLowerCase(), node.asset.relative]),
  );

  const claimants = new Map<string, string[]>();
  for (const conversion of converting.values()) {
    const key = conversion.target.toLowerCase();
    const list = claimants.get(key) ?? [];
    list.push(conversion.asset);
    claimants.set(key, list);
  }

  const withdraw = new Set<string>();
  for (const [key, assets] of claimants) {
    const contested = assets.length > 1;
    const existing = alreadyThere.get(key);

    if (!contested && existing === undefined) continue;

    const sorted = [...assets].sort();
    for (const asset of sorted) {
      declined.push({
        path: asset,
        line: null,
        reason: collisionReason(asset, sorted, existing, converting, key),
      });
      withdraw.add(asset);
    }
  }
  return withdraw;
}

/**
 * Say which pattern references match an asset that does not convert.
 *
 * A pattern is never rewritten (`collectRewrite` declines every one), so this changes no
 * decision. It reports one: this reference matches N assets and M of them do not convert,
 * which is where a reader looks to find out why a pattern still names the old format.
 * Under `replace`, a target only patterns reach is not converted and counts among the M,
 * as does a target declined for its own reason; a target a literal also names converts
 * and keeps its original while the pattern needs it.
 */
function declinePartialPatterns(
  input: PlanInput,
  converting: ReadonlyMap<string, PlannedConversion>,
  relativeOf: ReadonlyMap<string, string>,
  declined: Declined[],
): void {
  for (const reference of input.graph.references) {
    if (reference.resolution !== 'resolved-pattern') continue;

    const targets = reference.resolvedPaths.map((path) => relativeOf.get(path) ?? toPosix(path));
    const unmeasured = targets.filter((target) => !converting.has(target));
    if (unmeasured.length === 0) continue;

    const reason =
      `a template reference matches ${targets.length} assets and ${unmeasured.length} of them ` +
      `do not convert, so rewriting it would break the reference for all ${targets.length}`;
    declined.push({ path: relativePath(input.graph.root, reference.file), line: null, reason });
  }
}

interface RewriteContext {
  readonly input: PlanInput;
  /** Absolute project root, so a reference's file becomes a root-relative path. */
  readonly root: string;
  readonly converting: ReadonlyMap<string, PlannedConversion>;
  readonly relativeOf: ReadonlyMap<string, string>;
  readonly edits: Map<string, Edit[]>;
  readonly declined: Declined[];
}

/**
 * Decide whether one reference is repointed, and record why when it is not.
 *
 * Returns whether an edit was recorded. The deletion check needs exactly that: an original
 * may go only once every reference to it has moved, and "moved" means an edit this plan
 * holds, not what kind of reference it is.
 */
function collectRewrite(reference: Reference, context: RewriteContext): boolean {
  if (!isLinked(reference)) return false;

  const targets = linkedPaths(reference).map(
    (path) => context.relativeOf.get(path) ?? toPosix(path),
  );
  const converted = targets.filter((target) => context.converting.has(target));
  if (converted.length === 0) return false;

  const obstacle = obstacleTo(reference, context.input);
  if (obstacle?.kind === 'refused') {
    context.declined.push({
      path: relativePath(context.root, reference.file),
      line: null,
      reason: `${obstacle.why}, so ${converted.join(', ')} was converted without this reference moving`,
    });
    return false;
  }

  // A pattern is never rewritten: its text is a template, not a path with a range to
  // replace. Its originals stay under either policy, so it keeps resolving. The sentence
  // below says every target converted, so it is written only when that is true; a partial
  // pattern is already reported by `declinePartialPatterns`.
  if (obstacle?.kind === 'pattern') {
    if (converted.length === targets.length) {
      context.declined.push({
        path: relativePath(context.root, reference.file),
        line: null,
        reason:
          'a template reference is assembled at runtime, so its text cannot be repointed even though every asset it matches converted',
      });
    }
    return false;
  }

  if (obstacle !== null) return false;

  const file = relativePath(context.root, reference.file);
  const list = context.edits.get(file) ?? [];
  list.push({
    start: reference.start,
    end: reference.end,
    replacement: withExtension(reference.rawPath, context.input.format),
  });
  context.edits.set(file, list);
  return true;
}

/** A reference that links at least one asset: the only kind a plan could move. */
type LinkedReference = Extract<Reference, { resolution: 'resolved' | 'resolved-pattern' }>;

/** Why a plan leaves a linked reference where it is, even when its asset converts. */
type Obstacle =
  /** A rule forbids editing this text; `why` is the sentence saying which. */
  | { readonly kind: 'refused'; readonly why: string }
  /** The text is a template standing for several files, not a path with a range to edit. */
  | { readonly kind: 'pattern' }
  /** The path has no extension, so swapping it would change nothing. */
  | { readonly kind: 'unchanged' };

/**
 * What stops this plan moving a linked reference to the converted file, or null when
 * nothing does.
 *
 * One function answers two questions: whether `collectRewrite` records an edit, and,
 * under `replace`, whether an asset is worth converting at all. Answered in two places,
 * the answers would drift, and the first sign would be a converted file nothing points
 * at. Nothing here depends on which other assets convert, which is what lets the second
 * question be asked before the plan exists.
 */
function obstacleTo(reference: LinkedReference, input: PlanInput): Obstacle | null {
  const refusal = rewriteRefusal(reference, input);
  if (refusal !== null) return { kind: 'refused', why: refusal };
  if (reference.resolution === 'resolved-pattern') return { kind: 'pattern' };
  if (withExtension(reference.rawPath, input.format) === reference.rawPath) {
    return { kind: 'unchanged' };
  }
  return null;
}

/** The end of every sentence `unusedUnderReplace` writes: the rule, and the way round it. */
const REPLACE_CONVERTS_ONLY_WHAT_MOVES =
  '`--replace` converts an image only when a reference moves to the new file; without `--replace` it can be converted with the original kept';

/**
 * Under `replace`, why converting this asset would give it a new file nobody uses, or
 * null when at least one reference moves to it.
 *
 * The conversion half of the rule whose deletion half is `originalsStillNeeded`. The
 * sentence names the first reference holding the asset and counts the rest, in the form
 * the kept-original sentences use, so a reader can find the line to change.
 * See "The transaction" in ARCHITECTURE.md.
 */
function unusedUnderReplace(node: AssetNode, input: PlanInput): string | null {
  const blocked: { reference: LinkedReference; obstacle: Obstacle }[] = [];
  for (const reference of node.references) {
    if (!isLinked(reference)) continue;
    const obstacle = obstacleTo(reference, input);
    if (obstacle === null) return null;
    blocked.push({ reference, obstacle });
  }

  const [first] = blocked;
  if (first === undefined) {
    const held = input.hedged.has(node.asset.relative)
      ? 'nothing Upfly can see links to it, and something it could not read mentions it by its current name'
      : 'nothing Upfly can see links to it';
    return `${held}, so a new file would be used by nobody. ${REPLACE_CONVERTS_ONLY_WHAT_MOVES}`;
  }

  const where = `\`${relativePath(input.graph.root, first.reference.file)}\``;
  const more = blocked.length === 1 ? '' : ` (and ${blocked.length - 1} more)`;
  const text = `\`${first.reference.rawPath}\`${more}`;
  const held =
    first.obstacle.kind === 'pattern'
      ? `${where} reaches it only through ${text}, a path assembled at runtime that no run can rewrite`
      : first.obstacle.kind === 'refused'
        ? `${where} names it as ${text}, and this run does not rewrite that reference: ${first.obstacle.why}`
        : `${where} names it as ${text}, which has no extension to change`;
  return `${held}. No reference would move to a new file, so it would be used by nobody. ${REPLACE_CONVERTS_ONLY_WHAT_MOVES}`;
}

/**
 * Why this reference may not be rewritten, or null when it may.
 *
 * An unsafe reference has no static path to replace. A guess that happened to resolve
 * against the project root shows the asset is alive and nothing more, because the code may
 * join that string to a different directory. `rewriteRefusalFor` in `relocate.ts` applies
 * the same tests, so a change here belongs there too.
 */
function rewriteRefusal(reference: LinkedReference, input: PlanInput): string | null {
  if (reference.confidence === 'unsafe') {
    return 'the reference has no static path to replace';
  }
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
 * Which originals `replace` must keep because a reference Upfly knows about still needs
 * them, and why, keyed by asset.
 *
 * An original is deleted only when at least one reference links to it and this plan
 * rewrites every reference that does. Stated as a property rather than as cases, it covers
 * a pattern (a template or a `+` chain), a literal whose rewrite is refused (the old-path
 * search misses one with an encoded spelling), a path with no extension to change, and an
 * asset nothing links to. `unusedUnderReplace` declines that last case before it gets
 * here, and it is kept so this rule never depends on the conversion rule.
 * See "The transaction" in ARCHITECTURE.md.
 */
function originalsStillNeeded(
  input: PlanInput,
  converting: ReadonlyMap<string, PlannedConversion>,
  rewritten: ReadonlySet<Reference>,
): ReadonlyMap<string, string> {
  const needed = new Map<string, string>();
  for (const node of input.graph.assets) {
    if (converting.get(node.asset.relative)?.replacesOriginal !== true) continue;
    const reason = whyStillNeeded(node.references, rewritten, input.graph.root);
    if (reason !== null) needed.set(node.asset.relative, reason);
  }
  return needed;
}

/** The sentence for one original `replace` keeps, or null when every reference to it moves. */
function whyStillNeeded(
  references: readonly Reference[],
  rewritten: ReadonlySet<Reference>,
  root: string,
): string | null {
  // Unreachable while `unusedUnderReplace` declines every unlinked asset first. Kept so
  // this rule never depends on that one: see `originalsStillNeeded`.
  if (references.length === 0) {
    return (
      'converted, but the original was kept: nothing Upfly can see links to it, so no ' +
      'reference moved to the replacement — `--replace` removes an original only once every ' +
      'reference to it has moved, and whatever loads this one is somewhere Upfly cannot read'
    );
  }

  const missed = references.filter((reference) => !rewritten.has(reference));
  const [first] = missed;
  if (first === undefined) return null;

  // One location plus a count, as the surviving-mention reason does: the sentence stays
  // readable, and a reader who opens the named file finds the rest by searching for it.
  const where = `\`${relativePath(root, first.file)}\``;
  const text = `\`${first.rawPath}\`${missed.length === 1 ? '' : ` (and ${missed.length - 1} more)`}`;
  return first.resolution === 'resolved-pattern'
    ? `converted, but the original was kept: ${where} reaches it through ${text}, a path assembled at runtime that no run can rewrite — deleting the original would break it`
    : `converted, but the original was kept: ${where} names it as ${text}, and this run does not rewrite that reference — deleting the original would break it`;
}

/**
 * The conversions under `replace` whose originals survive, and why.
 *
 * An asset outside a served directory always keeps its original. Inside one, a reference
 * Upfly failed to rewrite shows as a missing image; outside, the asset is bundler-managed
 * and the same miss breaks the build, so `publicPolicy` governs served assets only. A
 * served asset keeps its original when a reference still needs it, with the sentence
 * `originalsStillNeeded` wrote. A user who asked for `replace` and gets originals back is
 * told why for each. Empty under `keep-original`, where every original is kept and saying
 * so for each would bury the cases that mean something.
 */
function keptOriginals(
  conversions: readonly PlannedConversion[],
  stillNeeded: ReadonlyMap<string, string>,
  input: PlanInput,
): KeptOriginal[] {
  if (input.publicPolicy !== 'replace') return [];

  const outside = noServingRootFound(input.servingRoots)
    ? `converted, but the original was kept: ${NO_WEBSITE_FOLDER}, and \`--replace\` removes ` +
      `an original only inside one. ${NAME_THE_WEBSITE_FOLDER}.`
    : 'converted, but the original was kept: it is outside a directory this project serves, ' +
      'where it is the build rather than a browser that resolves it — so a reference Upfly ' +
      'failed to rewrite would break the build instead of showing a missing image. ' +
      '`--replace` governs assets in a served directory.';
  return conversions
    .filter((conversion) => !conversion.replacesOriginal)
    .map((conversion) => ({
      asset: conversion.asset,
      reason: stillNeeded.get(conversion.asset) ?? outside,
    }))
    .sort((a, b) => compareStrings(a.asset, b.asset));
}

/** Said wherever no root was found, so served and bundled images cannot be told apart. */
const NO_WEBSITE_FOLDER =
  'no website folder was found in this project, so Upfly cannot tell which images a browser loads by URL';
const NAME_THE_WEBSITE_FOLDER =
  'Name the folder the site is served from with `--public <dir>` or `publicDirs` in the config file, using "." for the project root itself, as on a plain HTML site';

/**
 * The serving root an asset is under: the deepest root that contains it, or `null` when
 * none does. Every root counts, so an image in a monorepo's second website folder is as
 * served as one in its first.
 *
 * @param relative the asset's POSIX path, relative to the project root
 * @param servingRoots the roots the resolver used
 */
export function servingRootOf(relative: string, servingRoots: ServingRoots): string | null {
  let found: string | null = null;
  for (const dir of servingRoots.dirs) {
    if (!isUnderPublicDir(relative, dir)) continue;
    if (found === null || dir.length > found.length) found = dir;
  }
  return found;
}

/**
 * Whether the run has no serving root at all and the project did not declare that. Every
 * image then counts as not served, which keeps every original under `replace`, and the
 * report says how to name the folder rather than guessing the project root.
 */
export function noServingRootFound(servingRoots: ServingRoots): boolean {
  return servingRoots.dirs.length === 0 && !servingRoots.declared;
}

/**
 * Whether an asset is under a serving directory, where something outside the repository
 * may load it.
 *
 * `''` is answered before the prefix test: appending a slash to it gives `/`, which no
 * project-relative path starts with, so a site served from its own root would count none
 * of its assets as served.
 *
 * @param relative the asset's POSIX path, relative to the project root
 * @param publicDir the serving directory: `null` when nothing is served, `''` when the
 *   project serves from its own root, as a hand-written static site does
 */
export function isUnderPublicDir(relative: string, publicDir: string | null): boolean {
  if (publicDir === null) return false;
  if (publicDir === '') return true;
  const prefix = publicDir.endsWith('/') ? publicDir : `${publicDir}/`;
  return relative === publicDir || relative.startsWith(prefix);
}

/** Swap the extension, preserving everything before it exactly as written. */
function withExtension(path: string, format: EncodeFormat): string {
  const extension = extensionOf(path);
  if (extension === '') return path;
  return `${path.slice(0, path.length - extension.length)}.${format}`;
}
