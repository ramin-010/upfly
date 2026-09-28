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

import { posix, relative, sep } from 'node:path';

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

/**
 * Lowercase extension including the leading dot, or `''` if there is none, read as
 * `path.posix.extname` reads it on every platform. A reference such as `img/hero\.png` is
 * text, not a native path: its backslash never ends a folder, so no plan differs by machine. A
 * native path passed here names a file found by its extension, so its separators change nothing.
 */
export function extensionOf(filePath: string): string {
  return posix.extname(filePath).toLowerCase();
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
 * The characters a filename token holds: a letter or digit in any script, a combining mark (an
 * accent written decomposed, as macOS writes one), and `_`, `@`, `.` and `-`. Read with the
 * `u` flag; `\w` would not do, since it is ASCII alone with that flag or without it. No `/`,
 * so `{{ site.url }}/img/hero.png` yields `hero.png` and nothing longer, and no space, which
 * the walk over ` word` runs adds instead.
 */
const FILENAME_CLASS = '[\\p{L}\\p{M}\\p{N}_@.\\-]';

/**
 * Matches a tracked image extension where a name ends: `.png` in `hero (1).png`. Every pass
 * starts from one and walks left, since a pattern with a class this wide in front of the
 * extension would retry it from every letter of every word, several times slower on a scan
 * over every byte of every unread file.
 *
 * A fresh `RegExp` per call: a `g`-flagged literal carries `lastIndex` between uses,
 * which would make results depend on what was scanned before them.
 */
function extensionPattern(): RegExp {
  return new RegExp(`\\.(?:${EXTENSION_ALTERNATION})\\b`, 'gi');
}

/**
 * How many space-separated words may be added to the left of a match. Real filenames have
 * one to four words in all.
 */
const MAX_SPACED_WORDS = 6;

/** One character a filename token holds, a surrogate pair included. */
const FILENAME_CHARACTER = new RegExp(`^${FILENAME_CLASS}$`, 'u');

function isFilenameCharacter(character: string): boolean {
  return FILENAME_CHARACTER.test(character);
}

/**
 * How many code units the character that ends at `index` takes when `allowed` accepts it: two
 * for one outside the Basic Multilingual Plane, which UTF-16 writes as a surrogate pair, one
 * for any other, and none when it is refused or nothing comes before `index`.
 */
function widthBefore(text: string, index: number, allowed: (character: string) => boolean): number {
  const code = text.charCodeAt(index - 1);
  if (code >= 0xdc00 && code <= 0xdfff && index >= 2 && allowed(text.slice(index - 2, index))) {
    return 2;
  }
  return index >= 1 && allowed(text.charAt(index - 1)) ? 1 : 0;
}

/** Where the run of characters `allowed` accepts that ends at `index` starts, not below `floor`. */
function runStart(
  text: string,
  index: number,
  allowed: (character: string) => boolean,
  floor = 0,
): number {
  let start = index;
  let width = widthBefore(text, start, allowed);
  while (width > 0 && start - width >= floor) {
    start -= width;
    width = widthBefore(text, start, allowed);
  }
  return start;
}

/**
 * Every basename an image-looking token in `text` could be naming, with its offset.
 *
 * A token stops at a space, so on its own it sees `Firing Practice.webp` only as
 * `Practice.webp`, and an asset with a space in its name would be reported `dead` while its
 * name appears in the text. So from each token this walks left over ` word` runs and yields
 * every step: `Practice.webp`, then `Firing Practice.webp`. Yielding each step, not only the
 * longest, keeps shorter matches working: the prose `Remove workspace.png` must still match
 * an asset named `workspace.png`. A name is read in any script. Names holding parentheses
 * (`namesHoldingParentheses`), then percent-encoded ones, follow from the same extension.
 *
 * It lives here, and is exported, because every pass that looks for a name (`scan.ts`,
 * `sweep.ts`, a search for the names they missed) must ask the same question.
 *
 * @param text The text to search, whole.
 * @returns Each candidate name with the offset it starts at in `text`.
 * @example
 * [...imageFilenameCandidates('src="/img/team photo.png"')].map(([name]) => name);
 * // ['photo.png', 'team photo.png']
 */
export function* imageFilenameCandidates(text: string): Generator<[token: string, offset: number]> {
  const extensions = extensionPattern();
  let extension = extensions.exec(text);
  while (extension !== null) {
    const end = extension.index + extension[0].length;
    yield* spacedNames(text, extension.index, end);
    yield* namesHoldingParentheses(text, extension.index, end);
    yield* percentEncodedNames(text, extension.index, end);
    extension = extensions.exec(text);
  }
}

/**
 * The token that ends at the extension starting at `dot`, then each name that takes in one
 * more space-separated word to its left, up to `MAX_SPACED_WORDS`. A token longer than any
 * name a file system allows yields nothing.
 */
function* spacedNames(
  text: string,
  dot: number,
  end: number,
): Generator<[token: string, offset: number]> {
  const floor = Math.max(0, end - MAX_NAME_LENGTH);
  let start = runStart(text, dot, isFilenameCharacter, floor);
  if (start === dot || (start === floor && widthBefore(text, start, isFilenameCharacter) > 0)) {
    return;
  }
  yield [text.slice(start, end), start];

  for (let word = 0; word < MAX_SPACED_WORDS; word += 1) {
    if (text[start - 1] !== ' ') break;

    const candidate = runStart(text, start - 1, isFilenameCharacter);
    // A space with nothing filename-shaped before it is not part of a filename.
    if (candidate === start - 1) break;

    start = candidate;
    yield [text.slice(start, end), start];
  }
}

/** The longest name a common file system allows. */
const MAX_NAME_LENGTH = 255;

/** The longest such a name can be once percent-encoded, three characters for each byte. */
const MAX_ENCODED_LENGTH = MAX_NAME_LENGTH * 3;

/**
 * The names a run holding `%` that ends at the extension starting at `dot` can stand for: the
 * run as written, since a file's name may hold `%`, and the run percent-decoded, as a URL
 * names `vue photo.png` with `vue%20photo.png`. A start after each `(` is read too, as for a
 * name holding parentheses. A run with no `%` adds nothing, and one that does not decode adds
 * only itself. A decoded name is yielded at the offset where its encoded run starts.
 */
function* percentEncodedNames(
  text: string,
  dot: number,
  end: number,
): Generator<[token: string, offset: number]> {
  const floor = Math.max(0, end - MAX_ENCODED_LENGTH);
  const start = runStart(text, dot, isEncodedNameCharacter, floor);
  if (!text.slice(start, dot).includes('%')) return;

  const starts = [start];
  for (let index = start; index < dot; index += 1) {
    if (text[index] === '(') starts.push(index + 1);
  }
  for (const from of starts) {
    const written = text.slice(from, end);
    if (!written.includes('%')) continue;
    if (/[()]/.test(written) && !holdsBalancedParentheses(text, from, end)) continue;
    yield [written, from];
    const decoded = percentDecoded(written);
    if (decoded !== null && decoded !== written) {
      yield [decoded.slice(decoded.lastIndexOf('/') + 1), from];
    }
  }
}

function isEncodedNameCharacter(character: string): boolean {
  return character === '%' || isNameCharacter(character);
}

function percentDecoded(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

function isNameCharacter(character: string): boolean {
  return character === '(' || character === ')' || FILENAME_CHARACTER.test(character);
}

/**
 * The names holding parentheses that end at the extension starting at `dot`, shortest first,
 * such as `hero (1).png`, the name a browser gives a second download of `hero.png`.
 *
 * A separate pass, because parentheses in a token would change what it finds: the token in
 * `url(hero.png)` would be `url(hero.png`. Here only balanced parentheses stay in a name.
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
    start = runStart(text, wordEnd, isNameCharacter, floor);
    for (let index = wordEnd - 1; index >= start; index -= 1) {
      if (text[index] === '(') yield index + 1;
    }
    // An empty word is not part of a name; a run cut at the floor is longer than any name.
    if (start === wordEnd || (start === floor && widthBefore(text, start, isNameCharacter) > 0)) {
      return;
    }
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
