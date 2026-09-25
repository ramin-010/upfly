/**
 * Deciding what to convert and which references to repoint.
 *
 * Pure: it reads a graph and a set of measurements and returns decisions. Nothing
 * here touches a disk or encodes anything, so the whole policy surface is testable
 * without a filesystem and a wrong decision is visible before it is a written byte.
 *
 * Two rules shape almost all of it, and both run the same way. A reference is only
 * rewritten when we can prove where it points and how it is spelled; an asset is only
 * converted when converting it buys a rewrite we can actually make. Everything
 * declined leaves with a reason attached, because a skip nobody is told about is
 * indistinguishable from a decision nobody made.
 */

import type { Graph } from './graph.js';
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
   * Remove the original when at least one reference links to it AND this run rewrites
   * every reference that does (R180).
   *
   * Both halves are load-bearing. An asset nothing links to satisfies "every reference
   * points at the replacement" only vacuously, and a pattern is never rewritten however
   * many of its targets convert, so each of those keeps its original — reported in
   * `keptOriginals`, never silently.
   */
  | 'replace';

/**
 * Whether a root-relative path that resolved against the project root may be edited.
 *
 * A root-relative reference on a plain static site is the ordinary case and resolves
 * against the project root because there is no serving root to declare. The same
 * resolution on a project that *does* declare one is different: the path missed the
 * declared root and happened to exist at the project root, which may be coincidence
 * rather than a link.
 *
 * `when-no-serving-root` is the default because it separates those two on the fact
 * that distinguishes them rather than on a preference. It keys on whether the project
 * DECLARED a serving root, not on whether the resolver used one: a convention guess is
 * not a statement, and declining a link on the strength of a choice nobody made would
 * be the same mistake in the other direction.
 */
export type RootLinkPolicy = 'when-no-serving-root' | 'always' | 'never';

/**
 * The phrase that marks an R77 decline, shared so the two ends cannot drift apart.
 *
 * 🔴 `report.ts` raises a run-level caveat when any decline carries this, and it finds
 * them by matching text. A constant in one place makes that coupling explicit: reword the
 * sentence and the caveat follows. **The alternative — each module holding its own copy of
 * the wording — is a mechanism that stops firing silently the first time somebody improves
 * a sentence**, which is the defect this project keeps paying for.
 */
export const MENTION_SURVIVES = 'still names its path in a form Upfly cannot rewrite';

export interface PlanInput {
  readonly graph: Graph;
  /** Measurements. An asset with no entry here was never measured. */
  readonly probes: readonly AssetProbe[];
  readonly format: EncodeFormat;
  /** POSIX-relative, or null when the project serves nothing from a public directory. */
  readonly publicDir: string | null;
  readonly publicPolicy: PublicPolicy;
  /**
   * Assets with zero links that something unreadable nevertheless mentions.
   *
   * These are the audit's `possibly-dead` findings. They are the population R29 is
   * about: converting one changes a file on disk and rewrites nothing, because by
   * definition no reference points at it that we can see.
   */
  readonly hedged: ReadonlySet<string>;
  /**
   * Assets that must NOT be converted because a literal mention of their path would
   * survive the rewrite. **R77.**
   *
   * 🔴 **The trade, and it is this project's own rule rather than a convention:** a
   * surviving mention costs a lost saving; a deleted original costs a broken site. So
   * the expensive direction is chosen deliberately and the asset is declined.
   *
   * ⚠️ **Only ever populated when the policy would DELETE the original.** Under
   * `keep-original` the source stays on disk, an unrewritten mention still resolves, and
   * refusing a conversion over it would cost a saving to prevent nothing.
   *
   * Empty is the normal case and is a real answer. The caller does the searching because
   * this module is pure and the search reads files; `optimize` plans once, searches
   * against that plan, and plans again with this set filled in.
   */
  readonly blockedByMention?: ReadonlyMap<string, string>;
  /**
   * The serving roots the resolver used, carrying whether the project declared them.
   *
   * The same value the resolver was given, not a boolean derived beside it, so the
   * planner cannot be told the project declared a serving root while the resolver
   * resolved against a guess.
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
   * 🔴 **R131: `'lossless'` here is an instruction to `optimize`, not a label.** The plan
   * chose it because the lossless encode measured FEWER BYTES than the lossy one, so a
   * write that quietly used quality 80 would put a different file on disk from the one
   * whose saving was advertised. It travels to `encodeToFile` for that reason.
   */
  readonly quality: EncodeSetting;
  readonly savedBytes: number;
  /**
   * True when the original is removed: under `replace`, a served asset at least one
   * reference links to, every one of which this plan rewrites (R180).
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
 * Why the planner will not act at all, or null when it will.
 *
 * A returned refusal rather than a thrown error: a throw leaves the caller holding
 * nothing, while this is a finding with a reason, which is what rule 9 asks for. The
 * audit still reports on a misconfigured repository; only the write path stops.
 *
 * It deliberately replaces the per-asset `declined` list rather than joining it. When
 * the engine does not know where files are served from, every asset would decline for
 * the same reason, and N copies of one sentence buries the sentence.
 */
export interface PlanRefusal {
  readonly code: 'serving-root-unknown';
  /** A sentence a user can act on, naming what to do next. */
  readonly reason: string;
  readonly linked: number;
  readonly checkable: number;
}

/**
 * An asset that converted while its original was deliberately left in place (R66, R180).
 *
 * Under `replace` there are two reasons, and the `reason` says which. The asset sits
 * outside a served directory, where the build rather than a browser resolves it (R66); or
 * a reference Upfly knows about still needs the original — a pattern, which no run can
 * rewrite, a reference this run declined to rewrite, or no reference at all (R180).
 *
 * ⚠️ **Its own list, and not `declined`, because `declined` would make a heading
 * false.** The report renders that list under *"Examined and not converted"*, and
 * these assets **were** converted — filing them there would put a converted asset
 * under a heading saying it was not, which is the R21 #4 shape of two counts that
 * cannot both be true. Kept disjoint instead: an asset appears here **or** in
 * `declined`, never in both, and `conversions` still holds every conversion.
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
   * Conversions under `replace` whose original was kept anyway, and why (R66, R180).
   *
   * 🔴 **R66: the behaviour was correct and the silence was not.** R66 measured
   * `scratch-www` (2026-09-13): 374 conversions produced **373** deletes, and the one
   * asset whose original survived said so nowhere — a user who asked for `replace` got
   * 373 originals removed and 1 kept with nothing accounting for the difference. That
   * was the fifth silent omission of this phase, and the first where the *behaviour*
   * under it was right all along. ⚠️ A dated figure from before R180, which keeps more
   * originals than R66's rule did; R181 holds the re-measurement.
   */
  readonly keptOriginals: readonly KeptOriginal[];
  /**
   * Set when the planner refused to plan anything, and null on an ordinary run.
   *
   * A caller that writes must check this. When it is set the other three are empty,
   * so a caller that forgets writes nothing rather than writing something wrong,
   * which is the failure mode worth designing for.
   */
  readonly refusal: PlanRefusal | null;
}

/**
 * Every asset a pattern reference could match.
 *
 * Exposed so the caller can measure exactly these before planning, whatever encode
 * cap is otherwise in force. A pattern is one edit covering N assets, so rewriting it
 * is only safe if every one of those N converts to the same extension - which means
 * an unmeasured target does not merely cost detail, it makes the condition
 * impossible to establish. A cap that limits what we report is a convenience; a cap
 * that limits what we can prove is a correctness bug, so this exists to let the
 * caller lift it for a set that is finite and known in advance rather than leaving it
 * to a flag nobody knows to pass.
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
    const decision = convertDecision(node.asset.relative, node.references.length, input, savings);
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

  // 🔴 R180, and LAST on purpose: whether an original may go depends on which references
  // this plan actually rewrites, and that is only known once every one has been decided.
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
    // Derived from the surviving conversions rather than collected as they were
    // decided, so it cannot drift: an asset withdrawn later by `vetoCollisions` is no
    // longer a conversion and therefore no longer claims a kept original. Collecting
    // it earlier would have reported a kept original for a file that never converted.
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
 * An asset with no entry was never measured, which is different from one measured at
 * no saving. A measurement that came back larger than the source is dropped here: the
 * point of converting is a smaller file, and writing a bigger one is work that makes
 * the repository worse.
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
 * Whether this asset was actually encoded in the target format.
 *
 * The difference between "we looked and there was nothing to gain" and "we never
 * looked", which are the two things a null reason used to mean at once. Only the
 * second is reported elsewhere.
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
 * `reason: null` is for an asset there was never a decision to make about, and it is
 * narrower than it used to be. It covers an asset nothing measured, which the audit
 * already reports as a probe skip naming the cap, the vector or the format. It does
 * NOT cover an asset that was measured and came back no smaller: nothing anywhere
 * reported those, because a `format-opportunity` finding only exists when there is an
 * opportunity, and the audit's skip list only holds measurements that were not taken.
 *
 * Measured on the astro fixture: all seven assets encode larger as webp, the planner
 * declined all seven, and the report said nothing whatsoever about any of them. A
 * silent skip is a P0 (rule 9), so the measured case now carries a reason.
 */
function convertDecision(
  relative: string,
  linkCount: number,
  input: PlanInput,
  savings: ReadonlyMap<string, Saving>,
): ConvertDecision {
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

  const inPublic = isUnderPublicDir(relative, input.publicDir);

  // An asset nothing links to gains nothing from being converted: there is no
  // reference to repoint, so the only change is a new file on disk. Inside a public
  // directory that is still worth doing, because a public asset may be loaded by
  // something outside the repository that we cannot see — and the original stays where
  // it is under EITHER policy. `keep-original` never removes it; `replace` removes an
  // original only once every reference to it has moved, and an asset nothing links to
  // meets that only vacuously, so R180 keeps it and says why. Outside a public directory
  // it buys bytes and nothing else, and bytes do not justify touching a file whose
  // liveness we could not establish.
  if (linkCount === 0 && !inPublic) {
    const why = input.hedged.has(relative)
      ? 'nothing links to it and something we could not read mentions it, so converting would change a file whose references we cannot see'
      : 'nothing links to it, so converting it would rewrite no reference and gain only bytes';
    return { convert: false, reason: why };
  }

  // R77. Checked last, so the reason a reader sees is this one rather than a cheaper
  // decline that happened to fire first — the point of the message is to name the file
  // that is holding the conversion back.
  const surviving = input.blockedByMention?.get(relative);
  if (surviving !== undefined) {
    return {
      convert: false,
      // 🔴 Names WHERE, because a reason a reader cannot act on is half a rule-9
      // answer. The first draft said only that a mention survives *somewhere*, which
      // leaves the user to grep a repository for a path this engine had already found.
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
 * Every obstacle, not the first one that matched. A pair that collides with each other
 * AND with a file already there is still blocked after one of the pair is renamed, and
 * a sentence mentioning only the pair would send somebody round twice.
 *
 * Assets heading for the identically spelled target share a clause, because repeating
 * one sentence per file is how a three-way collision becomes unreadable. A target that
 * differs only in case gets its own clause and says why two names are one file, since
 * a reader looking at `Reaktor.webp` and `reaktor.webp` will otherwise conclude the
 * engine is broken.
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
 * Swapping an extension is not injective. `distance.png` and `distance.gif` both
 * become `distance.webp`, and a plan holding two creates at one path produces a result
 * that depends on which of them ran first. Separately, a target may already exist:
 * converting `logo.png` where `logo.webp` is already in the repository destroys a file
 * somebody made.
 *
 * Both cases decline every asset involved. Which of two files a user deliberately kept
 * under separate names should win is not a question this engine is in a position to
 * answer, and disambiguating the destination would put a filename in their repository
 * that they did not choose. Naming the other file is what lets them decide.
 *
 * Only planned conversions collide. Two assets sharing a basename where one of them
 * was never going to convert is not a collision: nothing is overwritten, the other
 * file stays where it is, and every reference to it keeps resolving. Declining it
 * would cost a real saving to avoid a hazard that is not there.
 *
 * Targets are compared case-insensitively, on every platform. `Reaktor.jpg` and
 * `reaktor.png` produce two target names that are two files on Linux and one file on
 * Windows and macOS, so an exact comparison writes one image over the other and
 * repoints a reference at the survivor, silently, on most people's machines. Comparing
 * case-folded everywhere costs a conversion on Linux that would have been safe there,
 * and buys an engine that decides the same thing wherever it runs. Reporting a
 * different plan on three operating systems for one repository is the worse trade,
 * and a wrong image is not a failure anybody would notice in time.
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
 * A pattern is never rewritten — `collectRewrite` declines every one, whatever its
 * targets did — so this changes no decision. It reports one: *this reference matches N
 * assets and M of them do not convert*, which is where a reader looks to find out why a
 * pattern still names the old format.
 *
 * 🔴 **Under `replace` it used to WITHDRAW the targets that did convert (R65), and that
 * is gone (R181).** The withdrawal rested on a pattern whose targets all convert being
 * rewritten and its originals deleted, so a partial one had to take every conversion
 * with it. The first half was never true: no pattern is rewritten. Under R180 no pattern
 * target loses its original either, because the pattern still names it. So a partial
 * pattern under `replace` converts what converts and keeps every original, exactly as
 * under `keep-original`, and each kept original says in `keptOriginals` which reference
 * still needs it.
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
 * Returns whether an edit was recorded. R180 needs exactly that: an original may go only
 * once every reference to it has moved, and "moved" means an edit this plan holds — not
 * what kind of reference it is.
 */
function collectRewrite(reference: Reference, context: RewriteContext): boolean {
  if (!isLinked(reference)) return false;

  const targets = linkedPaths(reference).map(
    (path) => context.relativeOf.get(path) ?? toPosix(path),
  );
  const converted = targets.filter((target) => context.converting.has(target));
  if (converted.length === 0) return false;

  const refusal = rewriteRefusal(reference, context.input);
  if (refusal !== null) {
    context.declined.push({
      path: relativePath(context.root, reference.file),
      line: null,
      reason: `${refusal}, so ${converted.join(', ')} was converted without this reference moving`,
    });
    return false;
  }

  // A pattern is never rewritten: its text is a template rather than a path, so there is
  // no range to repoint however many of its targets converted. The originals stay under
  // either policy — `keep-original` never removes one, and under `replace` R180 keeps any
  // original a reference this plan does not rewrite still names — so the reference keeps
  // resolving to them. "Even though every asset it matches converted" is only true when
  // every one did: a partial pattern was already reported, accurately, by
  // `declinePartialPatterns`, and this sentence beside it was the report contradicting
  // itself about one reference.
  if (reference.resolution === 'resolved-pattern') {
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

  const replacement = withExtension(reference.rawPath, context.input.format);
  if (replacement === reference.rawPath) return false;

  const file = relativePath(context.root, reference.file);
  const list = context.edits.get(file) ?? [];
  list.push({ start: reference.start, end: reference.end, replacement });
  context.edits.set(file, list);
  return true;
}

/**
 * Why this reference may not be rewritten, or null when it may.
 *
 * Each arm is a rule that already cost something to learn, stated as the fact rather
 * than as a citation: an unsafe reference has no static path to replace; a guess that
 * happened to resolve against the project root is evidence the asset is alive and
 * nothing more, because the code may join that string to a different directory
 * entirely.
 */
function rewriteRefusal(
  reference: Extract<Reference, { resolution: 'resolved' | 'resolved-pattern' }>,
  input: PlanInput,
): string | null {
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
 * 🔴 R180. Which originals `replace` must keep because a reference Upfly knows about still
 * needs them, and why — keyed by asset.
 *
 * **THE PROPERTY, stated once and enforced here: an original is deleted only when AT
 * LEAST ONE reference links to it AND this plan rewrites EVERY reference that does.**
 *
 * It replaces four pieces that were each right alone and wrong together: the policy's
 * definition (*"once every reference points at the replacement"*), a `replacesOriginal`
 * decided per asset with no regard to which rewrites were declined, a pattern veto that
 * assumed a pattern whose targets all convert IS rewritten, and `collectRewrite`, which
 * rewrites no pattern at all. Together they deleted all three originals behind
 * `/theme-${mode}.png` while the page went on asking for `.png`.
 *
 * Stated as the property rather than as the case that exposed it, so no member has to be
 * remembered: a pattern, template or `+` chain (R175); a literal whose rewrite is
 * refused, which until now only R77's text search protected — and that search cannot see
 * an encoded spelling; a reference whose rewrite would change nothing; and an asset
 * nothing links to, which meets "every reference has moved" only vacuously.
 *
 * ⚠️ **What it cannot see, stated so it is not read as a guarantee:** a reference the
 * graph never found. R77's search covers one written down literally. A path assembled at
 * runtime that the graph did not collect either is covered only when nothing else links
 * the asset, through the vacuous member.
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

/** The sentence for one original R180 keeps, or null when every reference to it moves. */
function whyStillNeeded(
  references: readonly Reference[],
  rewritten: ReadonlySet<Reference>,
  root: string,
): string | null {
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

  // One location plus a count, as R77's reason does: the sentence stays readable, and a
  // reader who opens the named file finds the rest by searching for the same text.
  const where = `\`${relativePath(root, first.file)}\``;
  const text = `\`${first.rawPath}\`${missed.length === 1 ? '' : ` (and ${missed.length - 1} more)`}`;
  return first.resolution === 'resolved-pattern'
    ? `converted, but the original was kept: ${where} reaches it through ${text}, a path assembled at runtime that no run can rewrite — deleting the original would break it`
    : `converted, but the original was kept: ${where} names it as ${text}, and this run does not rewrite that reference — deleting the original would break it`;
}

/**
 * The conversions under `replace` whose originals survive, and why (R66, R180).
 *
 * 🔴 **R66: an asset OUTSIDE a served directory keeps its original, and this reports it
 * rather than changing it.** Inside a served directory a reference we failed to rewrite
 * is a **404**: bad, but visible, and the user sees a missing image. Outside one the
 * asset is bundler-managed, and the same miss is a **build failure**. Those are different
 * severities, so they get different defaults, and the option is called `publicPolicy`
 * precisely because it governs public assets — it does not authorise deleting anything
 * else.
 *
 * **R180: a served asset keeps its original when a reference Upfly knows about still
 * needs it.** The sentence is `originalsStillNeeded`'s, which made the decision.
 *
 * ⚠️ **In R66's case what was wrong was the silence.** A user who asks for `replace` and
 * gets originals back needs the sentence, not the arithmetic.
 *
 * Empty under `keep-original`, where every original is kept and saying so for each would
 * bury the cases that mean something.
 */
function keptOriginals(
  conversions: readonly PlannedConversion[],
  stillNeeded: ReadonlyMap<string, string>,
  input: PlanInput,
): KeptOriginal[] {
  if (input.publicPolicy !== 'replace') return [];

  return conversions
    .filter((conversion) => !conversion.replacesOriginal)
    .map((conversion) => ({
      asset: conversion.asset,
      reason:
        stillNeeded.get(conversion.asset) ??
        'converted, but the original was kept: it is outside a directory this project serves, ' +
          'where it is the build rather than a browser that resolves it — so a reference Upfly ' +
          'failed to rewrite would break the build instead of showing a missing image. ' +
          '`--replace` governs assets in a served directory.',
    }))
    .sort((a, b) => compareStrings(a.asset, b.asset));
}

/**
 * Is this asset served from the public directory, where something outside may load it?
 *
 * `null` means the project serves nothing publicly. `''` is the opposite and means the
 * project serves from its own root, so every asset is public: a hand-written static
 * site with no build step is the repository it uploads.
 *
 * The empty case needs saying out loud because the arithmetic silently got it backwards.
 * Appending a slash to `''` gives `'/'`, and a project-relative path never begins with
 * one, so a root-served site scored false for every asset it has. That is the same
 * mistake the audit made about the same value, in different code, reached a different
 * way: there it decided which unreferenced assets carry an outside-link warning, and
 * here it decides whether an unlinked asset is worth converting at all and whether an
 * original may be removed once its references move.
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
