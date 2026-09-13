/**
 * What `broken before versus after` actually measures — stated next to the number.
 *
 * 🔴 **R72. The deepest finding of Phase 2, and it is not a bug.** B5 added a
 * reference to a moved asset in a file type nothing scans (`deploy/netlify.yml`) and
 * ran the move:
 *
 * ```
 * broken before: 0    broken after: 0    and the reference was broken
 * ```
 *
 * **The move broke a reference and the regression check reported nothing**, because
 * **the same graph that missed the reference does the counting.** It cannot do
 * otherwise. *"Broken before versus after"* proves we did not break what we **can
 * see**, and nothing more. **It is the shape of the check, not a defect in it**, which
 * is why this module states the limit rather than trying to remove it.
 *
 * ⚠️ **A number whose limit is unstated is read as a guarantee** — rule 9's spirit
 * applied to a figure instead of a finding. So the count and its limit are one value
 * here, and `lines` renders both or neither. A caller would have to dig the numbers
 * out and recompose the sentence to print one without the other, and that is visible
 * in a diff.
 *
 * 🔴 **Honest about what this module is: it is not a structural guarantee.** Nothing
 * in TypeScript stops a renderer reading `brokenAfter` and printing it bare. It makes
 * the honest path the short one and the dishonest path deliberate. Recording it as
 * structural would be worse than recording no guard at all, because it would stop the
 * next person looking.
 *
 * **The independent check that does not consult the graph is R72 part 2** — search
 * every file, parsed or not, for the old path string. This module is part 1, and part
 * 1 is what `relocate` may not reach a user without.
 */

import { plural } from './format.js';
import type { Graph } from './graph.js';
import { compareStrings } from './paths.js';
import type { ExcludedRoot, UnscannedExtension } from './types.js';
import { couldHideAReference } from './unscanned.js';

/** How many entries of a list are named before it is summarised. */
const NAMED_LIMIT = 5;

/**
 * Everything the before/after count is blind to, measured rather than hedged.
 *
 * Each field is a *class* of reference the comparison cannot see. They are separate
 * because a reader can act on them differently: the first is closed by an adapter, the
 * second by a configuration change, and the third by nothing at all.
 */
export interface MoveCoverageLimit {
  /**
   * Unread file types that could hold a path, named.
   *
   * Not every unread type: a `.woff2` holds no path text, and listing it would send a
   * user to read a font. `couldHideAReference` draws that line.
   */
  readonly typesThatCouldHide: readonly UnscannedExtension[];
  /** Files in those types. The count the first bullet quotes. */
  readonly unreadFileCount: number;
  /**
   * Directories the walk never descended into.
   *
   * 🔴 **These are not in `unreadFileCount`, and saying so is the point.** Their files
   * were never seen, so they are absent from the unread *count* as well as from the
   * graph — and a reader told "43 files went unread" would otherwise take 43 for the
   * whole blind spot. That is R72's own defect one level down, which is why this field
   * exists rather than being left out as a detail.
   */
  readonly neverRead: readonly ExcludedRoot[];
  /**
   * True when the two sides of the comparison did not read the same number of files.
   *
   * Then the difference between the counts may come from **coverage** rather than from
   * the move, and the comparison is not like-for-like. It should not happen — a move
   * relocates assets, not sources — so it is surfaced rather than assumed away.
   */
  readonly readDifferently: boolean;
  readonly unreadBefore: number;
  readonly unreadAfter: number;
}

/** The count, its verdict, and its limit — one value, deliberately. */
export interface MoveRegressionReport {
  readonly brokenBefore: number;
  readonly brokenAfter: number;
  /** More broken references than before. The only outcome that indicts the move. */
  readonly regressed: boolean;
  readonly limit: MoveCoverageLimit;
  /**
   * The verdict and its limit, rendered.
   *
   * Plain text, no locale formatting, for the same reason `report-human.ts` bans
   * `toLocaleString`: a deterministic artefact cannot contain a number that a
   * `small-icu` Node renders differently.
   */
  readonly lines: readonly string[];
}

export interface MoveCheckInput {
  /** The graph built before anything was written. */
  readonly before: Graph;
  /** The graph built over the tree the move just wrote. */
  readonly after: Graph;
  /**
   * Directories the walk never entered, from `DiscoveryResult.excludedRoots`.
   *
   * ⚠️ **Required, not optional, and `[]` is a real answer** — the same reasoning as
   * `RelocateInput.aliases`. Defaulting it to empty would let a caller that simply
   * forgot it print a blind spot of zero, which is the most confident wrong sentence
   * this module could produce.
   */
  readonly excludedRoots: readonly ExcludedRoot[];
}

/**
 * Compare broken references before and after a move, and say what that cannot see.
 *
 * Pure. Takes two graphs and returns sentences; reads no disk.
 */
export function checkMoveRegression(input: MoveCheckInput): MoveRegressionReport {
  const brokenBefore = input.before.byResolution.broken.length;
  const brokenAfter = input.after.byResolution.broken.length;

  const typesThatCouldHide = couldHideAReference(input.after.unscannedExtensions);
  const unreadBefore = input.before.unscannedFiles.length;
  const unreadAfter = input.after.unscannedFiles.length;

  const limit: MoveCoverageLimit = {
    typesThatCouldHide,
    unreadFileCount: typesThatCouldHide.reduce((total, entry) => total + entry.fileCount, 0),
    neverRead: [...input.excludedRoots].sort((a, b) => compareStrings(a.relative, b.relative)),
    readDifferently: unreadBefore !== unreadAfter,
    unreadBefore,
    unreadAfter,
  };

  const regressed = brokenAfter > brokenBefore;

  return {
    brokenBefore,
    brokenAfter,
    regressed,
    limit,
    lines: render(brokenBefore, brokenAfter, regressed, limit),
  };
}

/**
 * The verdict sentence and the limit beneath it.
 *
 * ⚠️ **The limit is never conditional on the verdict.** An early draft printed it only
 * when the count was clean, on the reasoning that a regression speaks for itself — but
 * a regression of 3 is just as silent about the fourth break it could not see, and
 * hiding the caveat exactly when the move has already proven fallible is backwards.
 */
function render(
  brokenBefore: number,
  brokenAfter: number,
  regressed: boolean,
  limit: MoveCoverageLimit,
): string[] {
  const lines = [
    `broken references: ${brokenBefore} before, ${brokenAfter} after`,
    `  ${verdict(brokenBefore, brokenAfter, regressed)}`,
    '',
    '  What that count cannot see. It is produced by the same graph that decides which',
    '  references exist, so it shows we did not break what Upfly can read, and no more:',
  ];

  lines.push(...unreadTypeLines(limit));
  lines.push(...neverReadLines(limit));

  // Applies in every tree, read or not, which is why it carries no count.
  lines.push(
    "    - a path a program assembles at runtime — '/img/' + name + '.png' — has no path",
    '      text to compare, so neither side of this count contains it.',
  );

  if (limit.readDifferently) {
    lines.push(
      '',
      `    🔴 The two sides did not read the same number of files: ${limit.unreadBefore} went unread`,
      `       before and ${limit.unreadAfter} after. Part of the difference between the counts may`,
      '       be coverage rather than this move, so the comparison is not like-for-like.',
    );
  }

  return lines;
}

/**
 * The headline, which carries the limit in its own sentence.
 *
 * *"No new broken references"* on its own is the sentence R72 is about. The qualifier
 * travels with it, so a reader who reads nothing else still does not read a guarantee.
 */
function verdict(brokenBefore: number, brokenAfter: number, regressed: boolean): string {
  if (regressed) {
    const added = brokenAfter - brokenBefore;
    return `🔴 REGRESSION — ${plural(added, 'reference')} Upfly can parse broke in this move`;
  }

  // Fewer than before is not a success to claim: the move did not repair anything, so
  // something else changed and a reader should be told rather than reassured.
  if (brokenAfter < brokenBefore) {
    return `⚠️ ${plural(brokenBefore - brokenAfter, 'reference')} fewer than before — a move repairs nothing, so this needs explaining`;
  }

  return 'no new broken references among those Upfly can parse';
}

/** The unread types, named. A count with no names is how a user learns nothing. */
function unreadTypeLines(limit: MoveCoverageLimit): string[] {
  if (limit.typesThatCouldHide.length === 0) {
    // Deliberately still a bullet. Dropping it here would turn a clean tree into an
    // implied guarantee, and the class is only absent from *this* tree.
    return [
      '    - a reference in a file type Upfly does not read could have broken without',
      '      appearing here. No unread file type in this tree could hold a path.',
    ];
  }

  // `That is N files, in M unread types` rather than `M types hold N files`: the
  // subject is invariant, so no count can disagree with the verb. The report has
  // shipped `1 file were not read` once and `report.ts` records three more near
  // misses, every one of them a sentence whose subject was a count.
  const lines = [
    '    - a reference in a file type Upfly does not read could have broken without',
    `      appearing here. That is ${plural(limit.unreadFileCount, 'file')}, in ${plural(limit.typesThatCouldHide.length, 'unread type')} that could hold a path:`,
  ];

  for (const entry of limit.typesThatCouldHide.slice(0, NAMED_LIMIT)) {
    lines.push(
      `        ${entry.ext === '' ? '(no extension)' : entry.ext} — ${plural(entry.fileCount, 'file')}`,
    );
  }
  if (limit.typesThatCouldHide.length > NAMED_LIMIT) {
    lines.push(`        ... and ${limit.typesThatCouldHide.length - NAMED_LIMIT} more`);
  }

  return lines;
}

/** The directories nobody opened, and the rule that closed each one. */
function neverReadLines(limit: MoveCoverageLimit): string[] {
  if (limit.neverRead.length === 0) return [];

  // No pronoun, which is what makes this work at both counts. The first draft read
  // `… so their files are not in the count above`, which says "1 directory … their
  // files"; `them` was the second draft and disagrees the same way. A sentence with
  // nothing to agree with cannot disagree. Both drafts were caught by rendering the
  // output and reading it, and no test had anything to say about either.
  const lines = [
    `    - ${plural(limit.neverRead.length, 'directory', 'directories')} went unopened, excluded by a rule. Nothing inside was read,`,
    '      so nothing inside is counted above either:',
  ];

  for (const entry of limit.neverRead.slice(0, NAMED_LIMIT)) {
    lines.push(`        ${entry.relative} — ${entry.reason}`);
  }
  if (limit.neverRead.length > NAMED_LIMIT) {
    lines.push(`        ... and ${limit.neverRead.length - NAMED_LIMIT} more`);
  }

  return lines;
}
