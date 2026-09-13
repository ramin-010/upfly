/**
 * After a move, look for the OLD path in every file — without asking the graph.
 *
 * 🔴 **R72 part 2.** Part 1 states what `broken before vs after` cannot see; this goes
 * and looks. The property that matters, and the only one, is **independence**: the check
 * that failed did so because *the same graph that missed the reference did the counting*,
 * so a second check built on the same graph would inherit the same blind spot wearing a
 * different name. **Nothing here reads a `Graph`.** It takes a list of files and a way to
 * read them, and searches text.
 *
 * ⚠️ **It searches the PATH, never the basename.** A move usually keeps the filename, so
 * a basename search matches the asset at its *new* location and proves nothing — it would
 * report a clean tree as full of survivors, and the noise would be indistinguishable from
 * the signal. `sweepForMentions` searches basenames, and was examined rather than reused:
 * it matches filename-shaped tokens, it picks its haystacks **from the graph**
 * (zero-reference assets only), and it deliberately skips excluded directories. Three
 * reasons, any one of which disqualifies it here.
 *
 * 🔴 **What a survivor IS, stated carefully.** It is an occurrence of the old path that
 * the move did not rewrite. That is usually a reference we could not repoint — and it may
 * also be prose, a changelog entry, a comment, or a coincidence. **This check cannot tell
 * those apart**, which is why it reports the line and lets a person read it, and why the
 * output says *occurrences to check* rather than *references we broke*. Reporting a
 * coincidence costs a glance; missing a break costs a 404.
 */

import { lineOf } from './citation.js';
import { plural } from './format.js';
import { compareStrings } from './paths.js';

/** One occurrence of an old path that survived the move. */
export interface Survivor {
  /** POSIX-relative path of the file it was found in. */
  readonly file: string;
  readonly line: number;
  /**
   * Byte offset of the match within the file.
   *
   * 🔴 Needed by `optimize`, and the reason is the one thing that makes this check
   * usable before a write rather than only after one: at plan time the old path is
   * still everywhere, including in the references the plan is **about to rewrite**.
   * Those are not survivors. Telling them apart needs the position, because a line
   * number cannot say whether a planned edit covers this occurrence.
   */
  readonly offset: number;
  /** Which spelling matched, so a reader knows what to look for on that line. */
  readonly spelling: string;
  /** The matching line, trimmed and capped. Evidence, so nobody has to open the file. */
  readonly text: string;
}

/** A file that could not be searched, and why. Never silently dropped. */
export interface Unsearchable {
  readonly file: string;
  readonly reason: string;
}

export interface OldPathSearchResult {
  readonly survivors: readonly Survivor[];
  readonly filesSearched: number;
  readonly unsearchable: readonly Unsearchable[];
  /** Every spelling looked for, so the search is reproducible by hand. */
  readonly spellings: readonly string[];
  /** The verdict and its limits. Both or neither, as in `move-check.ts`. */
  readonly lines: readonly string[];
}

export interface OldPathSearchInput {
  /** The moves that were carried out. Only `from` is searched for. */
  readonly moves: readonly { readonly from: string; readonly to: string }[];
  /**
   * Every file to search, POSIX-relative to the project root.
   *
   * ⚠️ **The caller decides the haystack, and that decision is a limit worth stating.**
   * Passing discovery's source *and* unscanned files searches strictly more than the
   * graph ever parsed, which is the point — but it still excludes directories an ignore
   * rule pruned, and the rendered limits say so.
   */
  readonly files: readonly string[];
  /** Reads one file by its POSIX-relative path. Rejecting is a reported `Unsearchable`. */
  readonly readFile: (relative: string) => Promise<string>;
  /**
   * Serving directories, so the URL spelling of a served asset can be derived.
   *
   * Configuration or detection output, **not graph knowledge** — no reference resolution
   * is consulted. Required rather than optional: without it `public/hero.png` would be
   * searched for only as `public/hero.png`, and the spelling that actually appears in
   * markup is `/hero.png`. A caller with none passes `[]` and says so.
   */
  readonly servingDirs: readonly string[];
}

/** How much of a matching line is kept as evidence. */
const TEXT_CAP = 120;

/**
 * Every way the old path might be written down.
 *
 * 🔴 **The tension this resolves, because it has no clean answer.** A long needle
 * (`public/img/hero.png`) misses the spelling that actually appears in markup
 * (`/img/hero.png`); a short one (`/hero.png`) matches half the repository. So several
 * spellings are searched and **each survivor names the one that matched**, which turns a
 * false positive into a glance rather than an investigation.
 *
 * ⚠️ **The parent-directory suffix is what catches relative spellings** — `./img/hero.png`
 * and `../../img/hero.png` both end in `img/hero.png`. The basename alone is deliberately
 * NOT a spelling, however tempting: after the move the asset still has that name.
 */
export function spellingsFor(from: string, servingDirs: readonly string[]): string[] {
  // 🔴 `/${from}` is the URL spelling for a project that serves its own root — the `''`
  // serving directory — and it is here unconditionally rather than in the loop below.
  // An explicit `if (dir === '')` branch WAS written, and a mutation proved it was dead
  // code: it added a string this line already contains, so breaking it changed nothing
  // and the test covering it stayed green. **A branch that never does anything looks
  // exactly like one that always works** — and the `''` case is the one this codebase has
  // got backwards twice in two modules (R70). It is handled here, once, in the open.
  const spellings = new Set<string>([from, `/${from}`]);

  // No `dir !== ''` guard here, and that is deliberate rather than an omission: for an
  // empty serving directory this condition reads `from.startsWith('/')`, and `from` is
  // project-relative so it never does. A guard was written, and a mutation showed it
  // could not change any outcome — the second dead branch this function grew around the
  // same `''` case in one sitting. Both are gone.
  for (const dir of servingDirs) {
    if (from === dir || from.startsWith(`${dir}/`)) {
      const served = from.slice(dir.length).replace(/^\/+/, '');
      if (served !== '') spellings.add(`/${served}`);
    }
  }

  // The suffix from the last directory separator but one: enough to be distinctive,
  // short enough to survive any relative prefix.
  const cut = from.lastIndexOf('/');
  if (cut > 0) {
    const parent = from.lastIndexOf('/', cut - 1);
    spellings.add(from.slice(parent + 1));
  }

  // Windows-style, which appears in generated manifests and in some config files.
  spellings.add(from.split('/').join('\\'));

  return [...spellings].sort(compareStrings);
}

/**
 * Search every file for the old paths. Reads text; never looks at a graph.
 *
 * Longest spellings first, and one match per line per file: a line containing
 * `/img/hero.png` matches both that spelling and the `img/hero.png` suffix, and reporting
 * it twice would make the count say two occurrences where a reader can see one.
 */
export async function findSurvivingPaths(input: OldPathSearchInput): Promise<OldPathSearchResult> {
  const spellings = [
    ...new Set(input.moves.flatMap((move) => spellingsFor(move.from, input.servingDirs))),
  ].sort((a, b) => b.length - a.length || compareStrings(a, b));

  // 🔴 Where the move PUT things, so a successful rewrite is not reported as a survivor.
  // Found by running this on `astro-docs` and reading the output: the asset served at
  // `/default-og-image.png` moved to `/upfly-moved/default-og-image.png`, and the old
  // URL spelling is a **suffix of the new one** — so the very file the move had correctly
  // rewritten came back as a survivor. **The basename problem in a new costume**: the
  // ruling warned that a move keeps the filename, and when an asset sits at the serving
  // root its whole URL is a filename with a slash on the front.
  const destinations = [
    ...new Set(input.moves.flatMap((move) => spellingsFor(move.to, input.servingDirs))),
  ];

  const survivors: Survivor[] = [];
  const unsearchable: Unsearchable[] = [];
  let filesSearched = 0;

  for (const file of [...input.files].sort(compareStrings)) {
    let text: string;
    try {
      text = await input.readFile(file);
    } catch (cause) {
      // A file that vanished or is binary is a hole in the search, and a hole in a
      // search that reports "nothing found" is exactly the defect R72 is about.
      unsearchable.push({ file, reason: (cause as Error).message });
      continue;
    }
    filesSearched++;

    const rewritten = spansOf(text, destinations);
    const claimed = new Set<number>();
    for (const spelling of spellings) {
      let at = text.indexOf(spelling);
      while (at !== -1) {
        const end = at + spelling.length;
        const line = lineOf(text, at);
        // Inside a destination path means the move wrote this text, so it is the rewrite
        // working rather than a reference left behind.
        if (!claimed.has(line) && !covered(rewritten, at, end)) {
          claimed.add(line);
          survivors.push({ file, line, offset: at, spelling, text: lineTextAt(text, at) });
        }
        at = text.indexOf(spelling, end);
      }
    }
  }

  survivors.sort(
    (a, b) =>
      compareStrings(a.file, b.file) || a.line - b.line || compareStrings(a.spelling, b.spelling),
  );

  return {
    survivors,
    filesSearched,
    unsearchable,
    spellings,
    lines: render(survivors, filesSearched, unsearchable, spellings),
  };
}

/** Every span of `text` occupied by one of `needles`, merged only as far as needed. */
function spansOf(text: string, needles: readonly string[]): [number, number][] {
  const spans: [number, number][] = [];
  for (const needle of needles) {
    let at = text.indexOf(needle);
    while (at !== -1) {
      spans.push([at, at + needle.length]);
      at = text.indexOf(needle, at + needle.length);
    }
  }
  return spans;
}

/**
 * Whether `[start, end)` lies inside one of the spans.
 *
 * ⚠️ **Containment, not overlap.** A match that merely touches a destination is still a
 * survivor: the question is whether the move WROTE this text, and it wrote exactly the
 * destination path and nothing around it.
 */
function covered(spans: readonly [number, number][], start: number, end: number): boolean {
  return spans.some(([from, to]) => from <= start && end <= to);
}

/** The line an offset sits on, trimmed and capped so a report stays readable. */
function lineTextAt(text: string, offset: number): string {
  const start = text.lastIndexOf('\n', offset) + 1;
  const end = text.indexOf('\n', offset);
  const line = text.slice(start, end === -1 ? text.length : end).trim();
  return line.length <= TEXT_CAP ? line : `${line.slice(0, TEXT_CAP)}...`;
}

/**
 * The finding and what it still cannot see.
 *
 * Same rule as `move-check.ts`: the limits are not conditional on the verdict. **A clean
 * result is exactly where an unstated limit gets read as a guarantee**, and this check
 * has a large one — it can only find a path that is written down somewhere as text.
 */
function render(
  survivors: readonly Survivor[],
  filesSearched: number,
  unsearchable: readonly Unsearchable[],
  spellings: readonly string[],
): string[] {
  const lines = [
    survivors.length === 0
      ? `old paths: none of ${plural(spellings.length, 'spelling')} survives in ${plural(filesSearched, 'file')} searched`
      : `old paths: ${plural(survivors.length, 'occurrence')} to check, in ${plural(filesSearched, 'file')} searched`,
    '',
  ];

  for (const survivor of survivors.slice(0, 20)) {
    lines.push(
      `    ${survivor.file}:${survivor.line}  (${survivor.spelling})`,
      `      ${survivor.text}`,
    );
  }
  if (survivors.length > 20) lines.push(`    ... and ${survivors.length - 20} more`);
  if (survivors.length > 0) {
    lines.push(
      '',
      '    Each is an occurrence the move did not rewrite. Most will be references that',
      '    could not be repointed; some may be prose, a changelog or a coincidence. This',
      '    check reads text, so it cannot tell those apart — the line is printed so you can.',
      '',
    );
  }

  lines.push(
    '  What this search cannot see. It never consults the graph, which is the point, but',
    '  it can only find a path that is written down as text:',
    "    - a path a program assembles at runtime — '/img/' + name + '.png' — is not written",
    '      down anywhere, so nothing matches it.',
    '    - a path spelled some other way: URL-encoded, behind a CDN prefix, or split across',
    `      a concatenation. ${plural(spellings.length, 'spelling was', 'spellings were')} searched, listed below.`,
    '    - a file nobody handed this search. Directories excluded by an ignore rule are not',
    '      in the list, so nothing inside them was read.',
  );

  if (unsearchable.length > 0) {
    lines.push(
      `    - ${plural(unsearchable.length, 'file')} could not be read at all:`,
      ...unsearchable.slice(0, 5).map((entry) => `        ${entry.file} — ${entry.reason}`),
    );
  }

  lines.push('', `  spellings searched: ${spellings.join('  ')}`);

  return lines;
}
