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
import { extensionOf, relativePath, toPosix } from './paths.js';
import type { AssetProbe, EncodeFormat } from './probe.js';
import { isLinked, linkedPaths } from './reference.js';
import { resolutionHealth } from './resolution-health.js';
import type { ServingRoots } from './resolve.js';
import type { Edit, Reference } from './types.js';

/** What happens to the original when a public asset is converted. */
export type PublicPolicy =
  /** Write the converted file alongside and leave the original in place. */
  | 'keep-original'
  /** Remove the original once every reference points at the replacement. */
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
  readonly quality: number;
  readonly savedBytes: number;
  /** True when the original is removed once the references move. */
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

export interface OptimizationPlan {
  readonly conversions: readonly PlannedConversion[];
  readonly rewrites: readonly PlannedRewrite[];
  /** Everything the planner decided against, each with the reason it decided. */
  readonly declined: readonly Declined[];
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

  const vetoed = vetoPatterns(input, converting, relativeOf, declined);
  for (const asset of vetoed) converting.delete(asset);

  const edits = new Map<string, Edit[]>();
  for (const reference of input.graph.references) {
    collectRewrite(reference, {
      input,
      root: input.graph.root,
      converting,
      relativeOf,
      edits,
      declined,
    });
  }

  return {
    conversions: [...converting.values()].sort((a, b) => a.asset.localeCompare(b.asset)),
    rewrites: [...edits.entries()]
      .map(([file, list]) => ({ file, edits: [...list].sort((a, b) => a.start - b.start) }))
      .sort((a, b) => a.file.localeCompare(b.file)),
    declined: declined.sort(
      (a, b) => a.path.localeCompare(b.path) || a.reason.localeCompare(b.reason),
    ),
    refusal: null,
  };
}

interface Saving {
  readonly savedBytes: number;
  readonly quality: number;
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

type ConvertDecision =
  | { readonly convert: true; readonly conversion: PlannedConversion }
  | { readonly convert: false; readonly reason: string | null };

/**
 * Whether one asset is converted, and why not when it is not.
 *
 * `reason: null` is for an asset there was never a decision to make about - it has no
 * measured saving in this format, which the audit already reports. Declining those
 * here would bury the real decisions under a list of every file in the repository.
 */
function convertDecision(
  relative: string,
  linkCount: number,
  input: PlanInput,
  savings: ReadonlyMap<string, Saving>,
): ConvertDecision {
  const saving = savings.get(relative);
  if (saving === undefined) return { convert: false, reason: null };

  const target = withExtension(relative, input.format);
  if (target === relative) return { convert: false, reason: null };

  const inPublic = isUnderPublicDir(relative, input.publicDir);

  // An asset nothing links to gains nothing from being converted: there is no
  // reference to repoint, so the only change is a new file on disk. Inside a public
  // directory that is still worth doing, because a public asset may be loaded by
  // something outside the repository that we cannot see and the original stays where
  // it is. Outside one it buys bytes and nothing else, and bytes do not justify
  // touching a file whose liveness we could not establish.
  if (linkCount === 0 && !inPublic) {
    const why = input.hedged.has(relative)
      ? 'nothing links to it and something we could not read mentions it, so converting would change a file whose references we cannot see'
      : 'nothing links to it, so converting it would rewrite no reference and gain only bytes';
    return { convert: false, reason: why };
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
 * Drop the conversions that a pattern reference forbids.
 *
 * A pattern is a single edit standing for N assets, so the edit is only correct if
 * every one of those N ends up at the same extension. Converting 53 of 54 and leaving
 * the reference alone is fine; converting 53 of 54 and rewriting the reference breaks
 * all 54.
 *
 * Under `keep-original` the originals survive, so the pattern keeps resolving and the
 * conversions may stand: what is withdrawn is the rewrite, and that is reported so
 * nobody reads "converted" as "and the reference now points at it". Under `replace`
 * the originals are removed, so the conversions themselves have to go.
 */
function vetoPatterns(
  input: PlanInput,
  converting: ReadonlyMap<string, PlannedConversion>,
  relativeOf: ReadonlyMap<string, string>,
  declined: Declined[],
): ReadonlySet<string> {
  const withdraw = new Set<string>();

  for (const reference of input.graph.references) {
    if (reference.resolution !== 'resolved-pattern') continue;

    const targets = reference.resolvedPaths.map((path) => relativeOf.get(path) ?? toPosix(path));
    const unmeasured = targets.filter((target) => !converting.has(target));
    if (unmeasured.length === 0) continue;

    const reason =
      `a template reference matches ${targets.length} assets and ${unmeasured.length} of them ` +
      `do not convert, so rewriting it would break the reference for all ${targets.length}`;
    declined.push({ path: relativePath(input.graph.root, reference.file), line: null, reason });

    if (input.publicPolicy === 'replace') {
      for (const target of targets) withdraw.add(target);
    }
  }
  return withdraw;
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

/** Decide whether one reference is repointed, and record why when it is not. */
function collectRewrite(reference: Reference, context: RewriteContext): void {
  if (!isLinked(reference)) return;

  const targets = linkedPaths(reference).map(
    (path) => context.relativeOf.get(path) ?? toPosix(path),
  );
  const converted = targets.filter((target) => context.converting.has(target));
  if (converted.length === 0) return;

  const refusal = rewriteRefusal(reference, context.input);
  if (refusal !== null) {
    context.declined.push({
      path: relativePath(context.root, reference.file),
      line: null,
      reason: `${refusal}, so ${converted.join(', ')} was converted without this reference moving`,
    });
    return;
  }

  // A pattern that survived the veto still cannot be rewritten by replacing its path
  // text, because the text is a template rather than a path. Withdrawing the rewrite
  // and saying so is the honest outcome: the originals remain and the reference keeps
  // resolving to them.
  if (reference.resolution === 'resolved-pattern') {
    context.declined.push({
      path: relativePath(context.root, reference.file),
      line: null,
      reason:
        'a template reference is assembled at runtime, so its text cannot be repointed even though every asset it matches converted',
    });
    return;
  }

  const replacement = withExtension(reference.rawPath, context.input.format);
  if (replacement === reference.rawPath) return;

  const file = relativePath(context.root, reference.file);
  const list = context.edits.get(file) ?? [];
  list.push({ start: reference.start, end: reference.end, replacement });
  context.edits.set(file, list);
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

/** Is this asset served from the public directory, where something outside may load it? */
function isUnderPublicDir(relative: string, publicDir: string | null): boolean {
  if (publicDir === null) return false;
  const prefix = publicDir.endsWith('/') ? publicDir : `${publicDir}/`;
  return relative === publicDir || relative.startsWith(prefix);
}

/** Swap the extension, preserving everything before it exactly as written. */
function withExtension(path: string, format: EncodeFormat): string {
  const extension = extensionOf(path);
  if (extension === '') return path;
  return `${path.slice(0, path.length - extension.length)}.${format}`;
}
