/**
 * Assemble everything the pipeline learned into the shape people and agents read.
 *
 * The JSON is **public API** (rule 6): versioned, snapshot-tested, and changed only
 * deliberately. An agent reading `upfly audit --json` is as much a consumer as a
 * person reading the terminal, and it is the one that cannot ask what a field meant.
 *
 * Three properties this module exists to guarantee:
 *
 * **No absolute path ever reaches the output.** §5.1(f) runs the same repository
 * from two working directories and requires byte-identical JSON, and half the data
 * upstream carries both an absolute `path` and a POSIX `relative` — `SkippedEntry`,
 * `ExcludedRoot`, `UnscannedFile`, `Reference.file`. Projecting to the relative form
 * is this module's job, and there is a test that greps the serialised report for the
 * root.
 *
 * **Deterministic** (rule 11): every list sorted, no timestamps, no durations, and
 * no locale-dependent formatting anywhere near a number.
 *
 * **Nothing is dropped.** Every skip from every stage lands in one flat `skipped`
 * list. Rule 9 says a silent skip is a P0 bug, and a single list is much harder to
 * forget to append to than five per-stage ones.
 */

import { interpolationChunks, templateExpressionReason } from './adapters/reference-path.js';
import type { AuditResult, DeadFinding, Finding, PossiblyDeadFinding } from './audit.js';
import { formatBytes, plural } from './format.js';
import type { Graph } from './graph.js';
import type { Declined } from './manifest.js';
import {
  compareStrings,
  extensionOf,
  isImageExtension,
  isVectorExtension,
  relativePath,
} from './paths.js';
import { MENTION_SURVIVES } from './plan.js';
import type { AssetProbe, EncodeFormat, ProbeSkipCode } from './probe.js';
import { isLinked } from './reference.js';
import type { ServingRoots } from './resolve.js';
import type { Mention, SweepResult } from './sweep.js';
import type {
  Confidence,
  DiscoveryResult,
  Reference,
  Resolution,
  ResolvedVia,
  UnscannedExtension,
} from './types.js';
import { groupUnscanned } from './unscanned.js';

/**
 * Schema version of the JSON report.
 *
 * Bumped when a field changes meaning or disappears — never for an addition, since
 * a consumer that ignores unknown fields keeps working.
 *
 * **2 — R22.** `findings` no longer holds every finding the audit produced: an
 * unreferenced vector nothing can act on is demoted to `unusedVectors`, and
 * `summary.findings` counts the itemised set so the two can never disagree. That is a
 * change of meaning in the array a consumer is most likely to read, so it earns the
 * bump even though `unusedVectors` and `staleConversions` are themselves additions.
 * The alternative — leaving the vectors in place and flagging them — would have kept
 * the version at 1 by making an agent and a person disagree about the same run.
 *
 * ⚠️ **Deliberately NOT bumped for `byResolvedVia` (R36).** It is a pure addition — no
 * existing field changes meaning and no consumer that ignores unknown keys is
 * affected — so the rule above applies as written. The `ResolvedVia` *type* did change
 * (`project-root` split in two), but that is the exported TypeScript API rather than
 * the report schema, and it belongs to package versioning. Bumping here for an
 * addition would train readers to ignore the number.
 *
 * ⚠️ **Deliberately NOT bumped for `diagnosticsFile` or for R64's probe codes either**,
 * and both halves follow the rule above rather than bending it. `diagnosticsFile` is a
 * pure addition; nothing that existed changes meaning. R64 replaced `header-unreadable`
 * with `not-an-image` and `svg-unreadable` and added `too-large-to-encode` — which
 * *sounds* like a breaking change and is not one **here**, because `SkippedItem` carries
 * `what`, `stage` and `reason` and never a code. `ProbeSkipCode` is the exported
 * TypeScript API, so it belongs to package versioning, exactly as `ResolvedVia` did.
 * Checked rather than assumed: the fixtures cannot show it, because not one of them has
 * an asset that fails to decode.
 */
export const REPORT_SCHEMA_VERSION = 4;

/** The numbers people screenshot. */
export interface ReportSummary {
  readonly assets: number;
  readonly assetBytes: number;
  readonly sourceFiles: number;
  readonly references: number;
  /** References that point at an asset — via `isLinked`, so patterns count. */
  readonly linkedReferences: number;
  /** Assets with at least one reference. */
  readonly referencedAssets: number;
  readonly findings: Readonly<Record<Finding['kind'], number>>;
  /**
   * Best measured saving per asset, summed.
   *
   * The best, not the total: an asset measured against both webp and avif would
   * otherwise be counted twice and the headline number would be a fiction.
   */
  readonly potentialSavingBytes: number;
  /**
   * The encode quality each measured format was produced at.
   *
   * Derived from the measurements themselves rather than from configuration, so it
   * always describes the run that produced `potentialSavingBytes` even if the
   * configuration changed afterwards. Empty when nothing was probed.
   *
   * A saving without this is not a figure. The same image saves 95% at quality 50
   * and 44% at quality 90, and a reader who is not told which cannot know what they
   * are being offered.
   */
  readonly savingQuality: Readonly<Partial<Record<EncodeFormat, number>>>;
  /** `false` when the run was `--no-probe`; oversized and opportunities are absent. */
  readonly probed: boolean;
}

/**
 * R109's four boxes, as a FIELD the engine publishes rather than a rule four consumers
 * each re-derive (R111).
 *
 * |  | the engine acted | the engine refused |
 * |---|---|---|
 * | **there is an answer** | **A** resolved it — success | **B** missed it — the only ordinary failure |
 * | **there is no answer** | **D** claimed it anyway — the dangerous failure | **C** refused it — success |
 *
 * \U0001f534 **THE ENGINE CANNOT CLASSIFY D, AND THE SCHEMA SAYS SO OUT LOUD RATHER THAN OMITTING
 * IT.** D is *we were wrong and do not know it* — a false link, a false `broken`, a false
 * `dead`. By construction the engine believes every one of those was right, so a
 * self-reported D would always be zero. **A consumer computing REFUSAL ACCURACY = C / (C + D)
 * against a self-reported D gets 100% for free**, which is the decoy-oracle failure moved
 * into the schema — precisely what R111 exists to prevent. D comes from an independent
 * oracle (`bench/src/verify.ts`), and R119 and R121 are what happens when that oracle shares
 * the engine's assumptions.
 *
 * \U0001f534 **AND THE DEFAULT IS AGAINST US.** *"There is no answer"* is our own judgement, so
 * `correctly-refused` requires a NAMED property of the reference drawn from the closed list
 * in `REFUSAL_REASONS`. Anything else is `missed-with-an-answer`. **If we cannot say why an
 * answer was impossible, we assume there was one and we missed it.** Adding a new refusal
 * reason is then a visible edit to a named list rather than a one-line tweak that moves a
 * reference from B to C and improves the headline (R109's guard 2).
 */
export type ReferenceClass =
  /** A — the engine found where it points. `broken` is HERE: we resolved it and told the truth. */
  | 'resolved-with-an-answer'
  /** B — an answer existed and we did not get it. The only ordinary failure. */
  | 'missed-with-an-answer'
  /** C — no answer existed and we declined, for a reason we can name about the reference. */
  | 'correctly-refused'
  /**
   * Not in any box: a path-shaped guess nobody asserted.
   *
   * ⚠️ **Kept out of both accuracy figures on purpose.** A string in a lockfile that looks
   * like a path was never a claim about an asset, so scoring ourselves on it measures the
   * engine against work that was never its job — R109's original objection, one level down.
   */
  | 'not-a-claim';

/**
 * The closed list of properties that prove a reference HAS NO ANSWER.
 *
 * \U0001f534 **This list is the guard on R109's trap, and its being a list is the guard.** Each
 * entry names something about the REFERENCE — its text, or a rule we published — that makes
 * an answer impossible for anyone, not merely hard for us. *"We cannot handle it"* is not on
 * the list and must never be added.
 *
 * ⚠️ Adding an entry moves references from `missed-with-an-answer` to `correctly-refused`
 * and improves the headline. **That is a reviewable edit here, not a one-line tweak
 * somewhere else**, which is the whole reason the test is a list membership rather than a
 * chain of conditions.
 */
const REFUSAL_REASONS: ReadonlyArray<{
  readonly id: string;
  readonly holds: (reference: Reference) => boolean;
  /**
   * What this reason is known to get WRONG, measured, or `null` when nothing is known.
   *
   * 🔴 **A refusal reason moves references out of *our miss* and into *correctly
   * refused*, which raises the headline. If we know it over-claims, the number cannot be
   * published without that knowledge attached** — so the bound travels in the schema
   * beside the count rather than in prose a consumer never reads. R74's habit: state the
   * blind spot where the figure is, not in a footnote somewhere else.
   */
  readonly bound: string | null;
  /**
   * WHAT the bound was measured against, and WHEN — required whenever `bound` is set.
   *
   * 🔴 **A bound nobody can check is R117 inside the schema.** The measurement is prose
   * in a string field: a person can verify it and a machine cannot, and it goes stale the
   * moment the corpus changes. **So it carries its own provenance**, and a reader who
   * knows the corpus has moved can tell at a glance that the sentence beside the count no
   * longer describes anything.
   *
   * ⚠️ It cannot be enforced automatically and is not pretending to be. What it does is
   * make the staleness VISIBLE rather than silent, which is the difference between a
   * figure that ages and one that quietly lies.
   */
  readonly measuredAgainst: string | null;
}> = [
  {
    // A deliberate boundary we published: a real file we choose not to index (R92).
    // The target is KNOWN — we simply do not act on it — so nothing was missed.
    id: 'out-of-scope',
    holds: (reference) => reference.resolution === 'out-of-scope',
    bound: null,
    measuredAgainst: null,
  },
  {
    // The path does not exist until something renders — a property of the written text,
    // and R112 measured that 46 of 62 such unknowns are a parameter or a prop, which no
    // analysis reaches.
    //
    // 🔴 **BOTH shared predicates, and the first version used only one.**
    // `interpolationChunks` is the RESOLVER's vocabulary — `${}`, `#{}`, `@{}`, the three
    // syntaxes a glob can be built from — and it does not know `{{ }}` or `{% %}`. Those
    // are 49 of the `dynamic` references on the five validation repositories, all of them
    // genuinely assembled at render time, and every one would have been filed as **our
    // miss**. The test caught it on the first run.
    //
    // ⚠️ **`templateExpressionReason` is the function that made these `dynamic` in the
    // first place**, so using it to explain why they were refused keeps one vocabulary
    // instead of inventing a sixth list (R76).
    id: 'assembled-at-runtime',
    holds: (reference) =>
      reference.resolution === 'dynamic' &&
      (templateExpressionReason(reference.rawPath) !== null ||
        interpolationChunks(reference.rawPath).length > 1),
    bound:
      'Of 62 such references, 46 are a parameter, a prop or instance state, which nothing reaches — but 16 are NOT. A same-file const with a finite set of values, a filename from a build-time glob, an imported module constant: those have an answer and we do not compute it, so they are misses this reason absorbs. Read as roughly three in four.',
    measuredAgainst:
      'R112, 2026-09-15, on the five pinned validation repositories (astro-docs, eleventy-docs, shadcn-ui, railsgirls-com, scratch-www). ⚠️ If that corpus has changed, this bound has not been re-measured and does not describe it.',
  },
  {
    // R118: the attribute could not be parsed as CSS AND provably holds no url-taking
    // function, so there is no reference inside it to find. The adapter established that
    // and said so; this reads its answer rather than re-deriving it.
    id: 'no-reference-in-it-to-find',
    holds: (reference) => (reference.note ?? '').includes('no reference in it to find'),
    bound: null,
    measuredAgainst: null,
  },
];

/**
 * Which of R109's boxes this reference is in.
 *
 * ⚠️ **`broken` is `resolved-with-an-answer` and that is not generosity (R109).** We found
 * where the reference points and reported the truth: the file is not there. That is the
 * user's defect and our success. Counting it against ourselves was part of the mistake
 * R109 was issued to correct.
 */
export function classifyReference(reference: Reference): ReferenceClass {
  if (reference.resolution === 'discarded') return 'not-a-claim';
  if (
    reference.resolution === 'resolved' ||
    reference.resolution === 'resolved-pattern' ||
    reference.resolution === 'broken'
  ) {
    return 'resolved-with-an-answer';
  }

  for (const reason of REFUSAL_REASONS) {
    if (reason.holds(reference)) return 'correctly-refused';
  }

  // \U0001f534 THE DEFAULT, and it is deliberately the unflattering one. An `unresolved-alias`
  // lands here: alias-shaped with no rule that maps it is OUR gap until somebody shows it
  // is not — a bundler config we did not read would have resolved it. So does a character
  // reference outside the decoder's bound (R118), and a style attribute that failed to
  // parse while containing a `url()`.
  return 'missed-with-an-answer';
}

/** The reason id that classified this reference as refused, for the itemised list. */
export function refusalReasonId(reference: Reference): string | null {
  for (const reason of REFUSAL_REASONS) {
    if (reason.holds(reference)) return reason.id;
  }
  return null;
}

/** One reference the engine declined to link, listed rather than merely counted. */
export interface ReferenceEntry {
  /** POSIX-relative source file. */
  readonly file: string;
  readonly rawPath: string;
  readonly resolution: Resolution;
  /** The adapter's note, or the exclusion rule — whichever explains this one. */
  readonly reason: string;
  /**
   * Which of R109's boxes this reference is in — a FIELD, not a derivation (R111).
   *
   * 🔴 **If the CLI derived it, the CLI, the extension, the agent contract and `bench/`
   * would each hold a copy of the rule and the copies would drift.** That is R76's two
   * vocabularies and R87's exemption list, in the schema. The engine decides once.
   */
  readonly classification: ReferenceClass;
  /**
   * WHICH named property made this a correct refusal, or `null` when it is not one.
   *
   * ⚠️ R109's guard 1: box C is ITEMISED, never totalled. A count of refusals is a
   * number anyone can inflate; a list of refusals with a reason each is something a
   * reader can disagree with.
   */
  readonly refusalReason: string | null;
}

/** A refusal reason this run relied on, and what it is known to get wrong. */
export interface ClassificationBound {
  readonly reason: string;
  /** How many references this run classified with it. */
  readonly count: number;
  /** The measured over-claim, in words a reader can check. */
  readonly bound: string;
  /**
   * What that measurement was taken against, and when.
   *
   * 🔴 Present so a reader can tell whether the sentence still applies. A bound with no
   * provenance is unfalsifiable, which is the failure R117 names — here, in the schema.
   */
  readonly measuredAgainst: string;
}

export interface ReferenceReport {
  readonly byResolution: Readonly<Record<Resolution, number>>;
  readonly byConfidence: Readonly<Record<Confidence, number>>;
  /**
   * How each linked reference reached its target, counted (R36).
   *
   * ⚠️ **This is not decoration: it is the only thing in the report that says which
   * links may be rewritten.** R15 holds that a link resolved by guessing at the base
   * proves the asset is *alive* without licensing an edit to the string — and until
   * this landed, `resolvedVia` appeared in the report zero times, so a consumer could
   * not tell a guess from an ordinary resolution and the planner would have had no
   * reason to give when it declined one. A silent decline is a rule 9 P0.
   *
   * Only `resolved` and `resolved-pattern` references have a `resolvedVia`, so these
   * counts sum to those two entries of `byResolution` and to nothing else.
   */
  readonly byResolvedVia: Readonly<Record<ResolvedVia, number>>;
  /**
   * Every reference in exactly one of R109's boxes, so neither accuracy figure can be
   * assembled wrongly (R111).
   *
   * **RESOLUTION ACCURACY = A / (A + B)** — `resolved-with-an-answer` over itself plus
   * `missed-with-an-answer`. That is the answer to *"how accurate is it"*.
   *
   * 🔴 **REFUSAL ACCURACY = C / (C + D) CANNOT BE COMPUTED FROM THIS OBJECT, AND THAT IS
   * DELIBERATE.** D is *we claimed something that was not there and do not know it*, which
   * the engine cannot self-report — a self-reported D is always zero and would hand every
   * consumer a free 100%. D comes from an independent oracle, and R119 and R121 are what
   * happens when that oracle shares the engine's assumptions.
   */
  readonly byClassification: Readonly<Record<ReferenceClass, number>>;
  /**
   * Always `true`. See {@link byClassification} — it marks the absence of D as a decision
   * rather than an oversight, which is the difference between a schema that is honest and
   * one that merely looks complete.
   */
  readonly refusalAccuracyIsNotSelfAssessable: true;
  /**
   * The known over-claims among the refusal reasons THIS RUN used, with their measurement.
   *
   * 🔴 **Empty means no reason in play is known to over-claim — it does NOT mean the
   * figure is exact.** A non-empty entry means `correctly-refused` is too high by a
   * measured amount and `missed-with-an-answer` is too low by the same amount, so a
   * consumer printing a resolution accuracy has this sitting next to the number it would
   * otherwise print alone.
   */
  readonly classificationBounds: readonly ClassificationBound[];
  /**
   * The "I could not be sure" bucket, in full: `dynamic`, `unresolved-alias` and
   * `out-of-scope`.
   *
   * Listed because this is the honesty that earns trust for the rest of the
   * report — it is exactly the set surfaced as "N references I couldn't safely
   * rewrite". `broken` is not here: it is a finding, with a line number.
   */
  readonly unsafe: readonly ReferenceEntry[];
  /**
   * Speculative path-shaped strings that did not resolve.
   *
   * Counted rather than listed by default: a large repository produces thousands
   * from lockfiles and i18n bundles, and listing them would bury everything else.
   */
  readonly discardedCount: number;
  /**
   * The discarded candidates themselves, when `includeDiscarded` asked for them.
   *
   * `null` — not `[]` — when they were not requested, because an empty array would
   * read as "there were none", which is the same class of lie as silence reading
   * as "no opportunity here".
   *
   * The list has to be reachable for a specific reason: the JSON adapter is
   * deliberately generous, so if it ever starts eating genuine references the
   * count tells you something is wrong while only the list tells you *what*. You
   * cannot debug that from an integer, and §1.1 promises these are inspectable.
   */
  readonly discarded: readonly ReferenceEntry[] | null;
}

/** What the engine did not read, and what it refused to enter. */
export interface CoverageReport {
  readonly unscannedExtensions: readonly UnscannedExtension[];
  readonly unscannedFileCount: number;
  readonly excludedRoots: readonly { readonly path: string; readonly reason: string }[];
  /**
   * Where a root-relative `/hero.png` was resolved from, and whether the project said
   * so or the engine worked it out.
   *
   * Here because a guess the report does not disclose is the defect R49 was: the
   * zero-false-`broken` figure was measured five times against serving roots somebody
   * had tuned by hand, which is configuration no first run produces. `declared: false`
   * already carries the distinction through the resolver and the planner; this is what
   * carries it to the person reading the output.
   *
   * The same type the resolver was handed, rather than a copy of its shape, so the
   * report cannot describe a run that did not happen.
   */
  readonly servingRoots: ServingRoots;
  /**
   * The mechanisms THIS RUN did not put to work, distinct from what it refused (R96, R111).
   *
   * 🔴 **R96 is the reason this exists and it is the worst bug the project has had, because
   * it made us look BETTER.** A `knownGap` saying *"the resolver climbs ancestors looking for
   * a directory named `public`, so it will wrongly resolve this"* was tested under DECLARED
   * serving roots — a configuration in which that climb never runs. The entry came out
   * `broken`, agreed with the key, and the harness printed *"the gap is closed"*, **retiring a
   * live defect and deleting the only written record of it.**
   *
   * ⚠️ **"Not exercised" is not "refused", and conflating them is the whole point.** A
   * refusal is something the engine considered and declined, and it is in `unsafe` with a
   * reason. This is machinery that never ran, so **the report says nothing about it either
   * way** — and a consumer that treats silence as a pass is making the mistake R96 names.
   */
  readonly notExercised: readonly NotExercised[];
}

/** One mechanism this run did not put to work, and why not. */
export interface NotExercised {
  /** A stable id a consumer can match on: `serving-root-detection`, `probe`, `aliases`. */
  readonly mechanism: string;
  /** Why it did not run — a fact about this run's INPUTS, never about the engine. */
  readonly why: string;
}

/** Where a skip happened, so a reader can tell a parse failure from a bad symlink. */
export type SkipStage = 'discovery' | 'scan' | 'sweep' | 'citation' | 'measurement';

/** One thing the engine declined to do. Rule 9's home in the report. */
export interface SkippedItem {
  /** POSIX-relative path of the file or asset involved. */
  readonly what: string;
  readonly stage: SkipStage;
  readonly reason: string;
}

/**
 * One unreferenced vector, as it appears behind the flag.
 *
 * A union rather than an optional `evidence`, mirroring the invariant
 * `PossiblyDeadFinding` already holds: no evidence means `dead`, so a hedge without its
 * citation is unrepresentable rather than merely discouraged.
 *
 * ⚠️ **It carries everything the finding carried, and that is load-bearing rather than
 * tidy.** §5.1(d)'s independent oracle walks `report.findings`, so the first version of
 * R22 silently removed 145 assets from the verification pass — astro-docs' verdict count
 * fell from 150 to 24 — and "0 confirmed-false" would have been quoted over a denominator
 * that had shrunk by 70% with nothing saying so. Demoting a finding from the default
 * report must not demote it out of being checked.
 */
export type UnusedVectorEntry =
  | {
      readonly kind: 'dead';
      /** POSIX-relative path. */
      readonly asset: string;
      readonly bytes: number;
    }
  | {
      readonly kind: 'possibly-dead';
      readonly asset: string;
      readonly bytes: number;
      /** Why it was hedged. Non-empty by construction, exactly as on the finding. */
      readonly evidence: readonly [Mention, ...Mention[]];
    };

/**
 * R22: unreferenced vectors, counted rather than itemised.
 *
 * **The argument is that we offer no action, not that vectors are small** — that
 * second claim was measured and is false: SVG is 96% of `shadcn-ui`'s hedged bytes.
 * We already decline to encode a vector (`VECTOR_EXTENSIONS`) and §8 decision 7 says
 * Upfly never deletes an asset, so itemising an unused one proposes the only two
 * things we will not do. On `astro-docs` this is 126 of 150 unreferenced-asset
 * findings, which is why the list was unreadable rather than merely long.
 *
 * Rule 9 is satisfied by `count` — nothing is silently dropped. `bytes` is here
 * because §8 decision 7 leaves the reader holding the decision, and a total is what
 * turns a list into one: `eleventy-docs`'s nine vectors are 210 KB, and nine
 * filenames would not have said that.
 */
/**
 * The assets the planner looked at and offered no action on.
 *
 * R22's shape, verbatim, because it is R22's situation: one counted line carrying the
 * total size, itemised behind a flag, because there is nothing to offer rather than
 * because the list is long. The discriminator is whether a user can act, never how
 * many there are.
 *
 * Empty on a run that never planned. Declines only exist once something has decided
 * what to convert, so an audit-only report carries a zero here rather than a guess.
 */
export interface DeclinedReport {
  readonly count: number;
  /** Their total size: the fact that turns a count into something worth reading. */
  readonly bytes: number;
  /**
   * The assets themselves, when `includeDeclined` asked for them.
   *
   * `null` rather than `[]` when not requested, for the reason the other two use it:
   * an empty array reads as "there were none".
   */
  readonly assets: readonly DeclinedEntry[] | null;
}

export interface DeclinedEntry {
  /** POSIX-relative path. */
  readonly asset: string;
  readonly bytes: number;
  /** Why the planner offered no action, in the planner's own words. */
  readonly reason: string;
}

export interface UnusedVectorReport {
  readonly count: number;
  /** Their total size, which is the fact that makes the count actionable. */
  readonly bytes: number;
  /**
   * The vectors themselves, when `includeUnusedVectors` asked for them.
   *
   * `null` — not `[]` — when they were not requested, for the same reason
   * `ReferenceReport.discarded` is: an empty array reads as "there were none", which
   * is the same class of lie as silence reading as "no opportunity here".
   */
  readonly assets: readonly UnusedVectorEntry[] | null;
}

/**
 * R23: an unreferenced vector standing beside a broken reference to its raster twin.
 *
 * Both halves are already findings on their own. Said together they mean *"you
 * converted this by hand and forgot the reference"*, which neither says alone — and
 * it is the one case where an unused vector **does** have an action, so these stay
 * itemised in `findings` rather than being demoted by R22.
 *
 * ⚠️ Deliberately **not** phrased as a conclusion. The pairing is two facts and their
 * proximity; the reader decides whether it is a forgotten conversion or a
 * coincidence of naming. R15's rule — a weak resolution must not drive an action —
 * applies to sentences as much as to rewrites.
 */
export interface StaleConversion {
  /** POSIX-relative path of the unreferenced vector. */
  readonly vector: string;
  /** The broken reference's path exactly as written. */
  readonly rawPath: string;
  /** `file:line` of the broken reference, so the reader can open it. */
  readonly where: string;
}

/** A limitation that applies to the report as a whole rather than to one finding. */
export interface Caveat {
  readonly code:
    | 'public-dir-dead'
    | 'framework-conventions'
    | 'nothing-to-measure'
    | 'not-probed'
    /**
     * Duplicates were not looked for, which is not the same as none being found.
     *
     * ⚠️ Without this line an absent check renders as `identical copies (0 sets)` —
     * or as nothing at all — and a reader concludes the repository is clean. Rule 9
     * calls that a silent skip, and it is the sixth this phase would have had.
     */
    | 'duplicates-not-checked'
    | 'encode-capped'
    | 'excluded-roots'
    | 'replace-held-back'
    | 'unscanned-extensions'
    | 'binary-file-types'
    | 'svg-both-ways'
    | 'unused-vectors';
  readonly count: number;
  /**
   * Rendered verbatim, and complete on its own.
   *
   * The count is interpolated into it rather than left for a renderer to prefix:
   * an agent reading the JSON gets a sentence it can quote, and a person is never
   * shown a bare `3:` to interpret.
   */
  readonly message: string;
  /**
   * The specifics, when a count alone would not be actionable.
   *
   * "no adapter reads these file types" is a shrug; naming `.njk (2 files)` is how
   * a user finds out which adapter they want.
   */
  readonly detail: readonly string[];
}

export interface Report {
  readonly version: number;
  readonly summary: ReportSummary;
  /**
   * Every finding there is something to do about, in the audit's report order.
   *
   * ⚠️ **Not every finding the audit produced** (R22, schema 2). An unreferenced
   * vector is in `unusedVectors` instead — unless it pairs with a broken reference to
   * its raster twin, which gives it an action and keeps it here. `summary.findings`
   * counts this array, so the two always agree.
   */
  readonly findings: readonly Finding[];
  /** R22: the unreferenced vectors this report declines to itemise, and their size. */
  readonly unusedVectors: UnusedVectorReport;
  /** R54: the assets a plan examined and offered no action on. */
  readonly declined: DeclinedReport;
  /** R23: unreferenced vectors beside a broken reference to their raster twin. */
  readonly staleConversions: readonly StaleConversion[];
  readonly references: ReferenceReport;
  readonly coverage: CoverageReport;
  /** Everything declined, from every stage, sorted. */
  readonly skipped: readonly SkippedItem[];
  /**
   * Where a reader can find what the third-party libraries actually said, or `null`.
   *
   * R64's second half. R60 moved libvips', PostCSS's and Babel's own wording out of
   * this artefact and into a diagnostic channel, which was right — the text is not
   * ours and it changes on a dependency upgrade — but it left a reader who wants that
   * detail with nowhere to look and nothing telling them one exists. **Naming the
   * file is what keeps rule 9 true across the move**: the text was relocated, not
   * dropped, and the report says so.
   *
   * A filename is deterministic content, so rule 11 is untouched — which is the whole
   * reason this is a name rather than the text it names.
   */
  readonly diagnosticsFile: string | null;
  readonly caveats: readonly Caveat[];
}

export interface ReportInput {
  readonly graph: Graph;
  readonly audit: AuditResult;
  /** For the entries only discovery saw: symlinks, unreadable files, pruned roots. */
  readonly discovery: DiscoveryResult;
  readonly sweep: SweepResult;
  /**
   * The serving roots the resolver was given, passed on rather than re-derived.
   *
   * Required, not optional. A report that could omit this could describe a guessed
   * resolution as though it were a declared one, which is the single thing this field
   * exists to prevent, and an optional field would let every caller forget.
   */
  readonly servingRoots: ServingRoots;
  /** Absent for a `--no-probe` run. */
  readonly probes?: readonly AssetProbe[];
  /**
   * Include the discarded candidates in full. Off by default (`--include-discarded`).
   *
   * Off because the list is usually thousands of lockfile strings; available
   * because a count alone cannot tell you *which* reference the JSON adapter
   * started eating.
   */
  readonly includeDiscarded?: boolean;
  /**
   * Itemise the unreferenced vectors R22 demotes. Off by default
   * (`--include-unused-svg`).
   *
   * Off because on `astro-docs` they are 126 of 150 unreferenced-asset findings and
   * there is no action to offer for any of them; available because a reader who wants
   * to audit our judgement should not have to take the count on trust.
   */
  readonly includeUnusedVectors?: boolean;
  /**
   * What a plan declined, if one was made.
   *
   * Absent for an audit-only run, which has no plan and therefore nothing to decline.
   * Bytes are not carried on `Declined` itself: they are looked up in the graph here,
   * so the manifest schema does not gain a field for the report's benefit.
   */
  readonly declined?: readonly Declined[];
  /** Itemise the declined assets. Off by default (`--include-declined`). */
  readonly includeDeclined?: boolean;
  /**
   * The name of the file this run wrote the libraries' own error text to.
   *
   * Optional, and absent is the honest answer for a caller that writes no such file —
   * naming one that does not exist would send a reader looking for nothing. `bench`
   * supplies it; the CLI will when it starts writing one.
   *
   * A **name**, not a path: an absolute path in the report would break rule 11 the
   * moment the same repository was audited from two checkouts, which is a defect this
   * codebase has already had once.
   */
  readonly diagnosticsFile?: string;
}

/** Build the report. Pure, and the only place that decides what the public shape is. */
export function buildReport(input: ReportInput): Report {
  const vectors = partitionUnusedVectors(input.audit.findings);

  return {
    version: REPORT_SCHEMA_VERSION,
    // The itemised set, not `audit.findings`: the summary counts what the report
    // shows, so a reader can never add up the findings and get a different number
    // from the one in the headline.
    summary: summarise(input, vectors.itemised),
    findings: vectors.itemised,
    unusedVectors: {
      count: vectors.demoted.length,
      bytes: vectors.demoted.reduce((total, entry) => total + entry.bytes, 0),
      assets: input.includeUnusedVectors ? vectors.demoted : null,
    },
    staleConversions: vectors.staleConversions,
    declined: declinedReport(input),
    references: referenceReport(input.graph, input.includeDiscarded ?? false),
    coverage: coverageReport(input),
    skipped: collectSkips(input),
    diagnosticsFile: input.diagnosticsFile ?? null,
    caveats: caveats(input, vectors),
  };
}

/** The last path segment, tolerating either separator — a raw path is as written. */
function baseNameOf(rawPath: string): string {
  const cut = Math.max(rawPath.lastIndexOf('/'), rawPath.lastIndexOf('\\'));
  return cut === -1 ? rawPath : rawPath.slice(cut + 1);
}

/** The filename without its extension. `''` for a dotfile, which pairs with nothing. */
function stemOf(rawPath: string): string {
  const base = baseNameOf(rawPath);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(0, dot);
}

/**
 * R22 and R23 in one pass, because they partition the same set.
 *
 * Order matters and is the whole design: R23's pairs are found **first**, and a paired
 * vector stays itemised. Demoting first and pairing afterwards would need the demoted
 * list back again, and the version of this that ran R22 alone would have hidden
 * exactly the 'you forgot the reference' cases R23 exists to surface.
 *
 * The audit still emits every finding (`audit.findings` is unchanged) — the graph's
 * account of what is unreferenced is not what R22 disputes. What the report decides is
 * which of them it can offer a reader an action for.
 */
/** Whether this finding is an unreferenced vector — the set R22 partitions. */
function isUnusedVector(finding: Finding): finding is DeadFinding | PossiblyDeadFinding {
  return (
    (finding.kind === 'dead' || finding.kind === 'possibly-dead') &&
    isVectorExtension(extensionOf(finding.asset))
  );
}

/** One broken reference, reduced to what R23 needs to say about it. */
interface BrokenRaster {
  readonly rawPath: string;
  readonly where: string;
}

/**
 * Broken references to a *raster*, indexed by filename stem.
 *
 * ⚠️ **Vectors are excluded, and that exclusion is the whole guard.** A broken reference
 * to another vector says nothing about a conversion: all 20 of `shadcn-ui`'s broken
 * references are `/next.svg`, `/vercel.svg` and `/vite.svg` from framework scaffolds, and
 * pairing those against its 10 unreferenced vectors would have invented ten conversion
 * stories out of matching filenames.
 */
function brokenRasterStems(findings: readonly Finding[]): ReadonlyMap<string, BrokenRaster[]> {
  const byStem = new Map<string, BrokenRaster[]>();
  for (const finding of findings) {
    if (finding.kind !== 'broken') continue;
    const extension = extensionOf(baseNameOf(finding.rawPath));
    if (!isImageExtension(extension) || isVectorExtension(extension)) continue;
    const stem = stemOf(finding.rawPath);
    if (stem === '') continue;
    byStem.set(stem, [
      ...(byStem.get(stem) ?? []),
      { rawPath: finding.rawPath, where: finding.where },
    ]);
  }
  return byStem;
}

/** R23: the pairs, and the vectors they rescue from R22's demotion. */
function findStaleConversions(findings: readonly Finding[]): {
  staleConversions: readonly StaleConversion[];
  paired: ReadonlySet<string>;
} {
  const byStem = brokenRasterStems(findings);
  const staleConversions: StaleConversion[] = [];
  const paired = new Set<string>();

  for (const finding of findings) {
    if (!isUnusedVector(finding)) continue;
    // Exact and case-sensitive. `Hero.png` is a different file from `hero.png` on the
    // platform most of this runs on, and a hint nobody asked for costs more trust than
    // one we declined to offer.
    for (const broken of byStem.get(stemOf(finding.asset)) ?? []) {
      staleConversions.push({
        vector: finding.asset,
        rawPath: broken.rawPath,
        where: broken.where,
      });
      paired.add(finding.asset);
    }
  }

  staleConversions.sort(
    (a, b) =>
      compareStrings(a.vector, b.vector) ||
      compareStrings(a.rawPath, b.rawPath) ||
      compareStrings(a.where, b.where),
  );
  return { staleConversions, paired };
}

/** One demoted vector, keeping everything the finding carried. */
function asUnusedVector(finding: DeadFinding | PossiblyDeadFinding): UnusedVectorEntry {
  return finding.kind === 'dead'
    ? { kind: 'dead', asset: finding.asset, bytes: finding.bytes }
    : {
        kind: 'possibly-dead',
        asset: finding.asset,
        bytes: finding.bytes,
        evidence: finding.evidence,
      };
}

function partitionUnusedVectors(findings: readonly Finding[]): {
  itemised: readonly Finding[];
  demoted: readonly UnusedVectorEntry[];
  staleConversions: readonly StaleConversion[];
} {
  const { staleConversions, paired } = findStaleConversions(findings);

  const itemised: Finding[] = [];
  const demoted: UnusedVectorEntry[] = [];
  for (const finding of findings) {
    if (isUnusedVector(finding) && !paired.has(finding.asset)) {
      demoted.push(asUnusedVector(finding));
    } else {
      itemised.push(finding);
    }
  }

  return { itemised, demoted, staleConversions };
}

function summarise(input: ReportInput, findings: readonly Finding[]): ReportSummary {
  const counts: Record<Finding['kind'], number> = {
    'serving-root-unknown': 0,
    broken: 0,
    dead: 0,
    'possibly-dead': 0,
    oversized: 0,
    'format-opportunity': 0,
    duplicate: 0,
  };
  for (const finding of findings) counts[finding.kind] += 1;

  // Best per asset, not the sum of every measurement: an asset measured against
  // both webp and avif would otherwise be counted twice.
  const bestSaving = new Map<string, number>();
  const savingQuality: Partial<Record<EncodeFormat, number>> = {};
  for (const finding of findings) {
    if (finding.kind !== 'format-opportunity') continue;
    bestSaving.set(finding.asset, Math.max(bestSaving.get(finding.asset) ?? 0, finding.savedBytes));
    savingQuality[finding.to] = finding.quality;
  }

  return {
    assets: input.graph.assets.length,
    assetBytes: input.graph.assets.reduce((total, node) => total + node.asset.bytes, 0),
    sourceFiles: input.discovery.sourceFiles.length,
    references: input.graph.references.length,
    linkedReferences:
      input.graph.byResolution.resolved.length +
      input.graph.byResolution['resolved-pattern'].length,
    referencedAssets: input.graph.assets.filter((node) => node.references.length > 0).length,
    findings: counts,
    potentialSavingBytes: [...bestSaving.values()].reduce((total, bytes) => total + bytes, 0),
    savingQuality,
    probed: input.audit.probed,
  };
}

function referenceReport(graph: Graph, includeDiscarded: boolean): ReferenceReport {
  const byResolution: Record<Resolution, number> = {
    resolved: graph.byResolution.resolved.length,
    'resolved-pattern': graph.byResolution['resolved-pattern'].length,
    'out-of-scope': graph.byResolution['out-of-scope'].length,
    dynamic: graph.byResolution.dynamic.length,
    broken: graph.byResolution.broken.length,
    discarded: graph.byResolution.discarded.length,
    'unresolved-alias': graph.byResolution['unresolved-alias'].length,
  };

  const byConfidence: Record<Confidence, number> = { certain: 0, high: 0, medium: 0, unsafe: 0 };
  for (const reference of graph.references) byConfidence[reference.confidence] += 1;

  // Only a linked reference has a `resolvedVia`, so `isLinked` is the gate rather
  // than a hand-written comparison against two resolution values (R15's lesson, and
  // the reason `isLinked` is exported at all).
  const byResolvedVia: Record<ResolvedVia, number> = {
    file: 0,
    'serving-root': 0,
    'project-root': 0,
    'speculative-root': 0,
  };
  for (const reference of graph.references) {
    if (isLinked(reference)) byResolvedVia[reference.resolvedVia] += 1;
  }

  const byClassification: Record<ReferenceClass, number> = {
    'resolved-with-an-answer': 0,
    'missed-with-an-answer': 0,
    'correctly-refused': 0,
    'not-a-claim': 0,
  };
  for (const reference of graph.references) byClassification[classifyReference(reference)] += 1;

  const boundCounts = new Map<string, number>();
  for (const reference of graph.references) {
    const id = refusalReasonId(reference);
    if (id !== null) boundCounts.set(id, (boundCounts.get(id) ?? 0) + 1);
  }
  const classificationBounds: ClassificationBound[] = [];
  for (const reason of REFUSAL_REASONS) {
    const count = boundCounts.get(reason.id) ?? 0;
    if (count > 0 && reason.bound !== null) {
      classificationBounds.push({
        reason: reason.id,
        count,
        bound: reason.bound,
        // A bound without its provenance is exactly the thing this field exists to stop,
        // so the fallback SAYS so rather than printing an empty string.
        measuredAgainst: reason.measuredAgainst ?? 'not recorded — treat this bound as unverified',
      });
    }
  }

  const unsafe: ReferenceEntry[] = [];
  for (const reference of graph.references) {
    if (
      reference.resolution !== 'dynamic' &&
      reference.resolution !== 'unresolved-alias' &&
      reference.resolution !== 'out-of-scope'
    ) {
      continue;
    }
    unsafe.push({
      file: relativePath(graph.root, reference.file),
      rawPath: reference.rawPath,
      resolution: reference.resolution,
      reason:
        reference.resolution === 'out-of-scope'
          ? reference.exclusionReason
          : (reference.note ?? defaultReason(reference.resolution)),
      classification: classifyReference(reference),
      refusalReason: refusalReasonId(reference),
    });
  }

  const discarded = includeDiscarded
    ? graph.byResolution.discarded.map((reference) => ({
        file: relativePath(graph.root, reference.file),
        rawPath: reference.rawPath,
        resolution: reference.resolution,
        reason: reference.note ?? 'a path-shaped string that resolved to nothing',
        classification: classifyReference(reference),
        refusalReason: refusalReasonId(reference),
      }))
    : null;

  return {
    byResolution,
    byConfidence,
    byResolvedVia,
    byClassification,
    refusalAccuracyIsNotSelfAssessable: true,
    classificationBounds,
    unsafe,
    discardedCount: byResolution.discarded,
    discarded,
  };
}

function defaultReason(resolution: 'dynamic' | 'unresolved-alias'): string {
  return resolution === 'dynamic'
    ? 'no static path to resolve'
    : 'alias-shaped; alias resolution arrives in Phase 2';
}

/**
 * The declined assets, sized from the graph.
 *
 * Deliberately tolerant of a declined path the graph does not know: the planner
 * declines by project-relative path and the graph is keyed the same way, so a miss
 * means the two disagree, and reporting the asset with zero bytes is better than
 * dropping it. Dropping it is the silence rule 9 forbids.
 */
function declinedReport(input: ReportInput): DeclinedReport {
  const declined = input.declined ?? [];
  const sizeOf = new Map(input.graph.assets.map((node) => [node.asset.relative, node.asset.bytes]));

  const assets = declined.map((entry) => ({
    asset: entry.path,
    bytes: sizeOf.get(entry.path) ?? 0,
    reason: entry.reason,
  }));

  return {
    count: assets.length,
    bytes: assets.reduce((total, entry) => total + entry.bytes, 0),
    assets: input.includeDeclined ? assets : null,
  };
}

function coverageReport(input: ReportInput): CoverageReport {
  return {
    unscannedExtensions: input.graph.unscannedExtensions,
    unscannedFileCount: input.graph.unscannedFiles.length,
    // Projected to `relative`: `ExcludedRoot` also carries an absolute `path`, and
    // letting that through is precisely the leak §5.1(f) tests for.
    excludedRoots: input.discovery.excludedRoots.map((root) => ({
      path: root.relative,
      reason: root.reason,
    })),
    servingRoots: input.servingRoots,
    notExercised: notExercised(input),
  };
}

/**
 * What this run did not exercise, decided from its INPUTS.
 *
 * ⚠️ Every entry is a fact about what the caller supplied, not a judgement about the
 * engine. That is what keeps this list from becoming a place to park excuses.
 */
function notExercised(input: ReportInput): NotExercised[] {
  const entries: NotExercised[] = [];

  if (input.servingRoots.declared) {
    entries.push({
      mechanism: 'serving-root-detection',
      why: 'the project declared its serving roots, so nothing had to infer them — a run that infers them can reach different files (R96)',
    });
  }

  if (input.probes === undefined) {
    entries.push({
      mechanism: 'probe',
      why: 'the run did not measure any asset, so oversized and format-opportunity findings could not be produced',
    });
  }

  return entries;
}

/**
 * Every skip from every stage, in one list.
 *
 * One list rather than five, because rule 9 is easier to keep when there is a single
 * place to append to — and because the human renderer prints this *first*, which
 * only works if it is one thing to print.
 */
/**
 * Probe outcomes that are conclusions rather than failures.
 *
 * Keyed on `ProbeSkipCode` rather than on the message, which is what that field is
 * for: a report that groups by prose breaks the moment somebody rewords a sentence.
 */
const DETERMINED_NOT_WORTH_MEASURING: ReadonlySet<ProbeSkipCode> = new Set([
  'vector',
  'already-target-format',
]);

function collectSkips(input: ReportInput): SkippedItem[] {
  const items: SkippedItem[] = [];

  for (const entry of input.discovery.skipped) {
    items.push({
      what: entry.relative,
      stage: 'discovery',
      reason: `${entry.reason}: ${entry.detail}`,
    });
  }

  // Unclaimed extensions are coverage, not failure — they belong in `coverage`.
  // A file an adapter claimed and could not read is a failure, and belongs here.
  for (const file of input.graph.unscannedFiles) {
    if (file.reason === 'unclaimed-extension') continue;
    items.push({ what: file.relative, stage: 'scan', reason: `${file.reason}: ${file.detail}` });
  }

  for (const skip of input.sweep.skipped) {
    items.push({ what: skip.relative, stage: 'sweep', reason: skip.reason });
  }

  for (const source of input.audit.unreadableSources) {
    items.push({ what: source.relative, stage: 'citation', reason: source.reason });
  }

  for (const probe of input.probes ?? []) {
    for (const skip of probe.skipped) {
      // A determination is not a failure (R21). `vector` and
      // `already-target-format` are Upfly working out that there is nothing to gain
      // and saying so — filing them here made `140 things Upfly could not handle`
      // false for 134 of the 140 on `astro-docs`, and repeated one sentence 126
      // times. They are counted in a caveat instead; the per-asset detail is
      // untouched in the JSON, so rule 9 holds and nothing is hidden.
      if (DETERMINED_NOT_WORTH_MEASURING.has(skip.code)) continue;
      items.push({
        what: probe.relative,
        stage: 'measurement',
        reason: `${skip.measurement}: ${skip.reason}`,
      });
    }
  }

  return items.sort(
    (a, b) =>
      compareStrings(a.stage, b.stage) ||
      compareStrings(a.what, b.what) ||
      compareStrings(a.reason, b.reason),
  );
}

/**
 * How many assets needed no measurement, and why, grouped by reason.
 *
 * One asset can contribute two entries — an SVG measured against both webp and avif
 * — so assets are counted once and the per-reason breakdown counts measurements.
 * The headline is the number of *images*, which is what a reader is counting.
 */
function countDeterminations(input: ReportInput): { total: number; detail: string[] } {
  const assets = new Set<string>();
  const byCode = new Map<ProbeSkipCode, number>();

  for (const probe of input.probes ?? []) {
    for (const skip of probe.skipped) {
      if (!DETERMINED_NOT_WORTH_MEASURING.has(skip.code)) continue;
      assets.add(probe.relative);
      byCode.set(skip.code, (byCode.get(skip.code) ?? 0) + 1);
    }
  }

  const label: Record<string, string> = {
    vector: 'vectors, where an encode would measure a rasterisation rather than a saving',
    'already-target-format': 'already in the format Upfly would convert to',
  };

  return {
    total: assets.size,
    // `thing — count`, matching the other detail lists, rather than `count thing`
    // which rendered as "126 a vector". It is also the shape that cannot disagree
    // with itself at one.
    detail: [...byCode]
      .sort((a, b) => b[1] - a[1] || compareStrings(a[0], b[0]))
      .map(([code, count]) => `${label[code] ?? code} — ${count}`),
  };
}

/** The limitations that apply to the whole run rather than to one finding. */
function caveats(input: ReportInput, vectors: { demoted: readonly UnusedVectorEntry[] }): Caveat[] {
  const list: Caveat[] = [];

  // R22. Rule 9 lives here: the demoted vectors are declined, so they reach the
  // report with a reason. The reason is the honest one — there is no action we would
  // offer — and not "they are small", which is measurably false.
  //
  // ⚠️ `not listed` is a participle, not a finite verb, and that is deliberate. The
  // first draft of this line read `${plural(n, 'unreferenced vector')} ... are not
  // listed`, which says "1 unreferenced vector are not listed" — the fifth instance
  // of that bug in this file, written directly underneath a comment about avoiding
  // it. There is nothing here for the count to disagree with now, and
  // "there is no action to offer" has an invariant subject.
  if (vectors.demoted.length > 0) {
    const bytes = vectors.demoted.reduce((total, entry) => total + entry.bytes, 0);
    list.push({
      code: 'unused-vectors',
      count: vectors.demoted.length,
      message: `${plural(vectors.demoted.length, 'unreferenced SVG')} totalling ${formatBytes(bytes)}, not listed — Upfly neither converts an SVG nor deletes an asset, so there is no action to offer. Use --include-unused-svg to see them.`,
      detail: [],
    });
  }
  // Counted over what this report actually lists, not over what the audit produced.
  //
  // `publicDirDeadCount` is computed before unreferenced vectors are demoted, and the
  // demotion happens here, so quoting it directly puts a number in a caveat that the
  // findings underneath cannot account for. Measured on railsgirls-com the moment the
  // caveat became reachable: 950 claimed against 903 `dead` findings listed, with a
  // second caveat saying 61 SVGs were not listed, and no arithmetic a reader can do
  // that reconciles the three. This project has already shipped that exact shape once,
  // as a suppressed count of 116 against 115 checkable references.
  const demotedAssets = new Set(vectors.demoted.map((entry) => entry.asset));
  const deadInPublic = input.audit.findings.filter(
    (finding) =>
      finding.kind === 'dead' && finding.inPublicDir && !demotedAssets.has(finding.asset),
  ).length;

  if (deadInPublic > 0) {
    // A project serving from its own root is a different sentence, not a louder one.
    // "Under the public directory" is meaningless when the public directory is the
    // whole repository, and the honest consequence is stronger than the general case:
    // there is no directory to exclude, so the reference graph cannot show that any
    // unreferenced file is unreachable. Saying that plainly is worth more than a
    // number the reader cannot act on.
    const servesFromRoot = input.servingRoots.dirs.includes('');
    list.push({
      code: 'public-dir-dead',
      count: deadInPublic,
      message: servesFromRoot
        ? `this project is served from its own root, so ${plural(deadInPublic, 'unreferenced image')} may be linked from outside this repository and Upfly cannot confidently call any of them safe to remove`
        : `${plural(deadInPublic, 'unreferenced image')} under the public directory may be linked from outside this repository`,
      detail: [],
    });
  }

  // R17. This line is load-bearing arithmetic, not a footnote: these assets have
  // zero references and produce no finding, so without it the headline's "N not
  // referenced" exceeds the dead and possibly-dead findings by an amount nothing
  // in the report explains. Naming the convention is the difference between a
  // reader trusting the gap and hunting for the bug.
  const convention = input.audit.conventionLinked;
  if (convention.length > 0) {
    list.push({
      code: 'framework-conventions',
      count: convention.length,
      message: `${plural(convention.length, 'unreferenced image')} are read by a framework from the filename, so they are not reported dead`,
      detail: convention.map((link) => `${link.asset} — ${link.reason}`),
    });
  }

  // R21: the count of things Upfly decided were not worth measuring, as one line
  // rather than 134. `astro-docs` is 126 vectors and 8 files already in the target
  // format — every one a successful determination, and the reader's question was
  // exactly right: *"if you can identify that, doesn't that count?"*
  const determined = countDeterminations(input);
  if (determined.total > 0) {
    list.push({
      code: 'nothing-to-measure',
      count: determined.total,
      message: `${plural(determined.total, 'image')} needed no measurement`,
      detail: determined.detail,
    });
  }

  if (!input.audit.duplicatesChecked) {
    list.push({
      code: 'duplicates-not-checked',
      count: 0,
      message:
        'assets were not compared byte for byte, so identical copies are unknown — this run reports no duplicates because it looked for none',
      detail: [],
    });
  }

  if (!input.audit.probed) {
    list.push({
      code: 'not-probed',
      count: 0,
      message: 'images were not decoded, so oversized assets and format opportunities are unknown',
      detail: [],
    });
  }

  const capped = (input.probes ?? []).filter((probe) =>
    probe.skipped.some((skip) => skip.code === 'beyond-encode-cap'),
  ).length;
  if (capped > 0) {
    list.push({
      code: 'encode-capped',
      count: capped,
      message: `${plural(capped, 'image')} beyond the measurement cap ${were(capped)} not encoded — run with --probe-all to measure the rest`,
      detail: [],
    });
  }

  // R21: three different things were sharing one sentence, and only one of them is
  // a gap anybody can close.
  //
  //   `.astro` (82 files) is a real coverage gap — an adapter would read it.
  //   `.mp4`, `.otf`, `.ttf`, `.ico` are **binary**. There is nothing to read and no
  //   adapter will ever change that, so listing them as something we failed to do is
  //   the same error as filing a vector under "could not handle".
  //   `.svg` is a third case entirely: it is tracked as an image asset *and* can
  //   itself hold references (`<image href>`), so it is deliberately in both places.
  //
  // Splitting them is what turns a list into three statements a reader can act on
  // differently. The counts still add up to the same total.
  const groups = groupUnscanned(input.graph.unscannedExtensions);

  // 🔴 R77. Stated once per run rather than inside 49 identical decline reasons, and
  // stated at all because **the bound is the interesting half**: the guard makes `replace`
  // safe for a path that is WRITTEN DOWN, and a path a program assembles at runtime is not
  // written down anywhere. Without this line a reader takes the refusals for completeness.
  const heldBack = (input.declined ?? []).filter((entry) =>
    entry.reason.includes(MENTION_SURVIVES),
  );
  if (heldBack.length > 0) {
    list.push({
      code: 'replace-held-back',
      count: heldBack.length,
      message: `${plural(heldBack.length, 'image')} kept rather than replaced, because a literal mention of the original's path would have outlived the rewrite`,
      detail: [
        'This check reads text, so it finds a path that is written down. A path a program',
        "assembles at runtime — '/images/' + name + '.png' — matches nothing, so replacing",
        'is safe here against literal mentions and no wider than that.',
      ],
    });
  }

  if (groups.adapterCould.length > 0) {
    const files = groups.adapterCould.reduce((total, entry) => total + entry.fileCount, 0);
    list.push({
      code: 'unscanned-extensions',
      count: files,
      message: `${plural(groups.adapterCould.length, 'file type')} had no adapter, so ${plural(files, 'file')} went unread`,
      // Naming them is the point: this is how a user discovers which adapter they
      // want, and it is the difference between a shrug and a next step.
      detail: groups.adapterCould.map(
        (entry) =>
          `${entry.ext === '' ? '(no extension)' : entry.ext} — ${plural(entry.fileCount, 'file')}`,
      ),
    });
  }

  if (groups.binary.length > 0) {
    const files = groups.binary.reduce((total, entry) => total + entry.fileCount, 0);
    list.push({
      code: 'binary-file-types',
      count: files,
      // Invariant subject, so the count cannot disagree with the verb. Written as
      // `${plural(files,'file')} are binary…` first, which reads "1 file are
      // binary" — the third instance of that bug in this file, committed an hour
      // after writing the note about avoiding it. A construction that cannot carry
      // it beats remembering to check.
      message: `binary formats have no text for an adapter to read, so no adapter ever will (${plural(files, 'file')} here)`,
      detail: groups.binary.map((entry) => `${entry.ext} — ${plural(entry.fileCount, 'file')}`),
    });
  }

  if (groups.svg > 0) {
    list.push({
      code: 'svg-both-ways',
      count: groups.svg,
      message: `SVG files are counted as images and also left unparsed: one can hold references of its own, and no adapter reads that yet (${plural(groups.svg, 'SVG')} here)`,
      detail: [],
    });
  }

  return list;
}

/** Verb agreement, so a report never says "1 file were not read". */
function were(value: number): string {
  return value === 1 ? 'was' : 'were';
}
