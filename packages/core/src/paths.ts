/**
 * Pure path helpers shared by every module that names a file.
 *
 * Two rules hold everywhere in the engine:
 *
 * 1. Paths the engine uses are absolute and native (they go to `fs`). Paths it reports
 *    are relative to the project root and POSIX-separated, so a report generated on
 *    Windows is byte-identical to one generated on Linux. That holds only if the
 *    conversion happens in one place, here.
 * 2. Ordering is by code unit, never by locale. See `compareStrings`.
 */

import { extname, relative, sep } from 'node:path';

/**
 * Image extensions the engine treats as assets, lowercase and dot-prefixed.
 *
 * `.tif` is included alongside `.tiff` because it is the same format under its
 * other conventional extension. SVG is tracked for the audit but never encoded; see
 * `VECTOR_EXTENSIONS`.
 */
export const IMAGE_EXTENSIONS: readonly string[] = Object.freeze([
  '.avif',
  '.gif',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.tif',
  '.tiff',
  '.webp',
]);

const IMAGE_EXTENSION_SET = new Set(IMAGE_EXTENSIONS);

/**
 * Image extensions that are vectors, lowercase and dot-prefixed.
 *
 * Encoding a vector rasterises it at an arbitrary density, so the byte count would measure
 * a picture of the asset rather than a saving; the probe declines it with a reason. The
 * report reads the same set to count an unused vector instead of itemising it, since
 * there is no action to offer for one. Both decisions use this one set so they cannot
 * drift apart. It is a subset of `IMAGE_EXTENSIONS`, asserted in `paths.test.ts`.
 */
export const VECTOR_EXTENSIONS: readonly string[] = Object.freeze(['.svg']);

const VECTOR_EXTENSION_SET = new Set(VECTOR_EXTENSIONS);

/**
 * Convert native separators to POSIX ones.
 *
 * Only where the backslash is the separator: it is a legal character in a POSIX
 * filename, so rewriting it there would corrupt a real path.
 */
export function toPosix(filePath: string): string {
  return sep === '\\' ? filePath.replaceAll('\\', '/') : filePath;
}

/**
 * The key an asset or source file is reported under: POSIX-separated and relative
 * to the project root.
 */
export function relativePath(root: string, absolute: string): string {
  return toPosix(relative(root, absolute));
}

/** Lowercase extension including the leading dot, or `''` if there is none. */
export function extensionOf(filePath: string): string {
  return extname(filePath).toLowerCase();
}

/** Whether an extension (as returned by `extensionOf`) names an image format. */
export function isImageExtension(extension: string): boolean {
  return IMAGE_EXTENSION_SET.has(extension);
}

/**
 * Whether an extension (as returned by `extensionOf`) names a vector format.
 *
 * A predicate rather than an exported `=== '.svg'` comparison, for the reason
 * `isLinked` exists: a comparison spelled out at each call site is a place the next
 * format can be forgotten, and the compiler cannot see the omission.
 */
export function isVectorExtension(extension: string): boolean {
  return VECTOR_EXTENSION_SET.has(extension);
}

/**
 * Total order over strings by UTF-16 code unit.
 *
 * Not `localeCompare`, which depends on the locale: the same repository would produce
 * differently ordered reports on two machines, and the report must be byte-identical for
 * the same input. This differs from code-point order only for astral-plane characters,
 * which does not matter for a stable order.
 */
export function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** The tracked extensions without their dots, as a regular-expression alternation. */
const EXTENSION_ALTERNATION = IMAGE_EXTENSIONS.map((extension) =>
  extension.slice(1).replace(/[^A-Za-z0-9]/g, '\\$&'),
).join('|');

/**
 * Matches a filename-shaped token ending in a tracked image extension.
 *
 * Built from `IMAGE_EXTENSIONS` so adding a format needs no change in the callers. The
 * character class excludes `/`, so `{{ site.url }}/img/hero.png` yields `hero.png` and
 * nothing longer. It excludes spaces too: a pattern that crosses them backtracks at every
 * word boundary and ran 1.7 to 5 times slower, on a scan over every byte of every unread
 * file. `imageFilenameCandidates` extends leftwards from each match instead.
 *
 * A fresh `RegExp` per call: a `g`-flagged literal carries `lastIndex` between uses,
 * which would make results depend on what was scanned before them.
 */
export function imageFilenamePattern(): RegExp {
  return new RegExp(`[\\w@.\\-]+\\.(?:${EXTENSION_ALTERNATION})\\b`, 'gi');
}

/** Matches a tracked image extension where a name ends: `.png` in `hero (1).png`. */
function extensionPattern(): RegExp {
  return new RegExp(`\\.(?:${EXTENSION_ALTERNATION})\\b`, 'gi');
}

/**
 * How many space-separated words may be added to the left of a match. Real filenames have
 * one to four words in all.
 */
const MAX_SPACED_WORDS = 6;

/** The characters `imageFilenamePattern` allows inside a filename token. */
const FILENAME_CHARACTER = /[\w@.\-]/;

/**
 * Every basename an image-looking token in `text` could be naming, with its offset.
 *
 * `imageFilenamePattern` cannot cross a space, so on its own it sees `Firing Practice.webp`
 * only as `Practice.webp`, and an asset with a space in its name would be reported `dead`
 * while its name appears in the text. So from each match this walks left over ` word` runs
 * and yields every step: `Practice.webp`, then `Firing Practice.webp`. Yielding each step,
 * not only the longest, keeps shorter matches working: the prose `Remove workspace.png`
 * must still match an asset named `workspace.png`. The names holding parentheses follow,
 * from a second pass (`namesHoldingParentheses`).
 *
 * It lives here because `scan.ts` and `sweep.ts` do the same lookup, and a hole in only one
 * of two identical lookups is easy to miss.
 */
export function* imageFilenameCandidates(text: string): Generator<[token: string, offset: number]> {
  const pattern = imageFilenamePattern();
  let match = pattern.exec(text);
  while (match !== null) {
    const end = match.index + match[0].length;
    yield [match[0], match.index];

    let start = match.index;
    for (let word = 0; word < MAX_SPACED_WORDS; word += 1) {
      if (text[start - 1] !== ' ') break;

      let candidate = start - 1;
      while (candidate > 0 && FILENAME_CHARACTER.test(text[candidate - 1] ?? '')) candidate -= 1;
      // A space with nothing filename-shaped before it is not part of a filename.
      if (candidate === start - 1) break;

      start = candidate;
      yield [text.slice(start, end), start];
    }
    match = pattern.exec(text);
  }

  const extensions = extensionPattern();
  let extension = extensions.exec(text);
  while (extension !== null) {
    yield* namesHoldingParentheses(text, extension.index, extension.index + extension[0].length);
    extension = extensions.exec(text);
  }
}

/** The longest name a common file system allows. */
const MAX_NAME_LENGTH = 255;

function isNameCharacter(character: string): boolean {
  return character === '(' || character === ')' || FILENAME_CHARACTER.test(character);
}

/**
 * The names holding parentheses that end at the extension starting at `dot`, shortest first,
 * such as `hero (1).png`, the name a browser gives a second download of `hero.png`.
 *
 * A separate pass, because parentheses in `imageFilenamePattern` would change what it finds:
 * its match in `url(hero.png)` would be `url(hero.png`. Here only an extension starts a walk.
 */
function* namesHoldingParentheses(
  text: string,
  dot: number,
  end: number,
): Generator<[token: string, offset: number]> {
  for (const start of startsOfNames(text, dot, end)) {
    if (holdsBalancedParentheses(text, start, end)) yield [text.slice(start, end), start];
  }
}

/**
 * Where a name ending at `dot` could start, nearest first: at each of up to seven
 * space-separated words, as the space walk counts them, and after each `(`, which may open a
 * construct such as `url(` rather than belong to the name.
 */
function* startsOfNames(text: string, dot: number, end: number): Generator<number> {
  const floor = Math.max(0, end - MAX_NAME_LENGTH);
  let start = dot;
  for (let word = 0; word <= MAX_SPACED_WORDS; word += 1) {
    const wordEnd = start;
    while (start > floor && isNameCharacter(text[start - 1] ?? '')) {
      start -= 1;
      if (text[start] === '(') yield start + 1;
    }
    // An empty word is not part of a name; a run cut at the floor is longer than any name.
    if (start === wordEnd || (start === floor && isNameCharacter(text[start - 1] ?? ''))) return;
    yield start;
    if (text[start - 1] !== ' ') return;
    start -= 1;
  }
}

/** Whether the text from `start` to `end` holds parentheses, all in balanced pairs. */
function holdsBalancedParentheses(text: string, start: number, end: number): boolean {
  let depth = 0;
  let pairs = 0;
  for (let index = start; index < end; index += 1) {
    if (text[index] === '(') depth += 1;
    if (text[index] === ')') {
      depth -= 1;
      pairs += 1;
    }
    if (depth < 0) return false;
  }
  return depth === 0 && pairs > 0;
}
