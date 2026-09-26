/**
 * What "broken before versus after" measures after a move, stated next to the number.
 *
 * The same graph that missed a reference does the counting, so the count shows only that
 * the move broke nothing Upfly can read. A limit left unstated is read as a guarantee, so
 * the count and its limit are one value and `lines` renders both. Nothing stops a caller
 * printing `brokenAfter` alone; this only makes stating the limit the shorter path.
 * `old-path-search.ts` is the check that does not consult the graph.
 * See "Moving an asset" in ARCHITECTURE.md.
 */

import { plural } from './format.js';
import type { Graph } from './graph.js';
import { compareStrings } from './paths.js';
import type { ExcludedRoot, UnscannedExtension, UnscannedFile } from './types.js';
import { couldHideAReference, countExtensions } from './unscanned.js';

/** How many entries of a list are named before it is summarised. */
const NAMED_LIMIT = 5;

/**
 * Everything the before/after count is blind to, measured rather than hedged.
 *
 * The classes are kept apart because a reader acts on each differently: an unread type
 * wants an adapter, an excluded directory a change of configuration, and a parse failure a
 * fix to that file.
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
   * Directories the walk never entered. Their files are in neither the graph nor
   * `unreadFileCount`, so without this a reader told "43 files went unread" would take 43
   * for the whole blind spot.
   */
  readonly neverRead: readonly ExcludedRoot[];
  /**
   * Files of a type Upfly reads that could not be parsed, kept apart from the unread types.
   * Grouped by extension they would read as "Upfly cannot read HTML" when each file failed
   * on its own fault, such as invalid CSS in an inline `<style>`. A parse failure is usually
   * fixable, and it is the likeliest place a break hides.
   */
  readonly parseFailed: readonly UnscannedFile[];
  /**
   * True when the two sides left a different number of files unread. The difference
   * between the counts may then come from coverage rather than from the move. A move
   * relocates assets, not sources, so this should not happen; it is reported rather than
   * assumed away.
   */
  readonly readDifferently: boolean;
  readonly unreadBefore: number;
  readonly unreadAfter: number;
}

/** The count, its verdict and its limit, as one value. */
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
   * Directories the walk never entered, from `DiscoveryResult.excludedRoots`. Required: a
   * default of `[]` would let a caller that forgot it report a blind spot of zero. A caller
   * with none passes `[]`.
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

  const parseFailed = input.after.unscannedFiles.filter((file) => file.reason === 'parse-failed');

  // Parse failures are left out, so the type list and the parse-failure list never count
  // the same file twice. `graph.unscannedExtensions` includes them, so it is not used here.
  const typesThatCouldHide = couldHideAReference(
    countExtensions(input.after.unscannedFiles.filter((file) => file.reason !== 'parse-failed')),
  );
  const unreadBefore = input.before.unscannedFiles.length;
  const unreadAfter = input.after.unscannedFiles.length;

  const limit: MoveCoverageLimit = {
    typesThatCouldHide,
    parseFailed,
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
 * The verdict sentence and the limit beneath it. The limit is printed whatever the
 * verdict: a regression of 3 says nothing about a fourth break the count could not see.
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
  lines.push(...parseFailedLines(limit));
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
 * The headline, which carries the limit in its own words ("Upfly can parse"), so a reader
 * who reads nothing else still does not read a guarantee.
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

/** The unread types, named, since a bare count gives a user nothing to act on. */
function unreadTypeLines(limit: MoveCoverageLimit): string[] {
  if (limit.typesThatCouldHide.length === 0) {
    // Still a bullet: dropping it would turn a clean tree into an implied guarantee, and
    // the class is absent only from this tree.
    return [
      '    - a reference in a file Upfly did not read could have broken without appearing',
      '      here. No unread file in this tree could hold a path.',
    ];
  }

  // `That is N files, in M types` rather than `M types hold N files`: the subject is fixed,
  // so no count can disagree with the verb.
  const lines = [
    '    - a reference in a file Upfly did not read could have broken without appearing',
    `      here. That is ${plural(limit.unreadFileCount, 'file')}, in ${plural(limit.typesThatCouldHide.length, 'type')} that could hold a path:`,
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

/**
 * Files Upfly tried to read and could not parse, each named with the parser's complaint.
 *
 * A reference in one of them is invisible on both sides of the count, so a move can break
 * it while the count stays level. Each is named rather than counted because, unlike an
 * unread type, it is one file a person can open and fix.
 */
function parseFailedLines(limit: MoveCoverageLimit): string[] {
  if (limit.parseFailed.length === 0) return [];

  const lines = [
    `    - ${plural(limit.parseFailed.length, 'file')} of a type Upfly DOES read could not be parsed, so no`,
    '      reference in them was seen and none could be rewritten. This is the likeliest',
    '      place a break is hiding, and unlike the types above it is usually fixable:',
  ];

  for (const entry of limit.parseFailed.slice(0, NAMED_LIMIT)) {
    const why = complaintOf(entry.detail);
    lines.push(`        ${entry.relative}${why === '' ? '' : ` — ${why}`}`);
  }
  if (limit.parseFailed.length > NAMED_LIMIT) {
    lines.push(`        ... and ${limit.parseFailed.length - NAMED_LIMIT} more`);
  }

  return lines;
}

/** The directories nobody opened, and the rule that closed each one. */
function neverReadLines(limit: MoveCoverageLimit): string[] {
  if (limit.neverRead.length === 0) return [];

  // No pronoun, so the sentence reads correctly for one directory or many.
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

/**
 * The parser's complaint without the prefixes in front of it, so
 * `ADAPTER_PARSE_FAILED: Could not parse: invalid css syntax at line 16, column 5` reads
 * `invalid css syntax at line 16, column 5`. The prefixes are trimmed by a fixed list
 * rather than at the first colon, because a CSS message can contain a colon of its own.
 */
function complaintOf(detail: string): string {
  let text = detail;
  for (const prefix of ['ADAPTER_PARSE_FAILED:', 'Could not parse:']) {
    if (text.startsWith(prefix)) text = text.slice(prefix.length).trimStart();
  }
  return text;
}
