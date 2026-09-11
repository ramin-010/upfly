/**
 * Pure path helpers shared by every module that names a file.
 *
 * Two rules hold everywhere in the engine:
 *
 * 1. Paths we *use* are absolute and native (they go to `fs`). Paths we *report*
 *    are relative to the project root and POSIX-separated, so a report generated
 *    on Windows is byte-identical to one generated on Linux. Rule 11 of the
 *    engineering constraints is only true if this is enforced in one place.
 * 2. Ordering is by code unit, never by locale. See `compareStrings`.
 */

import { extname, relative, sep } from 'node:path';

/**
 * Image extensions the engine treats as assets, lowercase and dot-prefixed.
 *
 * `.tif` is included alongside `.tiff` because it is the same format under its
 * other conventional extension; everything else is exactly the set in the build
 * plan. SVG is discovered but is audit-only until an SVGO adapter exists.
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
 * Encoding one rasterises it at some arbitrary density, so the resulting byte count
 * answers a question nobody asked: not "how much would this asset shrink" but "how
 * big would a picture of this asset be". SVG is audit-only until an SVGO adapter
 * exists, so the encode is declined *with a reason* rather than quietly producing a
 * misleading number.
 *
 * ⚠️ **This set is the reason two separate decisions agree, and it lives here so
 * they cannot drift apart** (R22). The probe declines to *encode* a vector — "a
 * rasterisation, not a saving" — and the report declines to *itemise an unused* one,
 * and R22's ruling rests on those being the same set: an unused vector is demoted to
 * a counted line precisely because there is no action we would offer for it. If one
 * site learned about a second vector format and the other did not, the report would
 * either itemise something the encoder still refuses to touch or stay silent about
 * something it would happily convert. Both are wrong and neither would throw.
 *
 * A subset of `IMAGE_EXTENSIONS` by construction, asserted in `paths.test.ts` —
 * demoting an unused asset we do not even track as an image would be incoherent.
 */
export const VECTOR_EXTENSIONS: readonly string[] = Object.freeze(['.svg']);

const VECTOR_EXTENSION_SET = new Set(VECTOR_EXTENSIONS);

/**
 * Convert native separators to POSIX ones.
 *
 * The `sep` check is not cosmetic: a backslash is a legal character in a POSIX
 * filename, so rewriting it there would corrupt a real path. We only translate on
 * platforms where the backslash actually is the separator.
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
 * Deliberately not `localeCompare`: that is locale-dependent, so the same repo
 * would produce differently ordered reports on two machines and rule 11
 * ("same inputs produce a byte-identical report") would quietly be false. We need
 * *a* stable total order, not a human-friendly one. This differs from code-point
 * order only for astral-plane characters, which does not matter for that purpose.
 */
export function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Matches a filename-shaped token ending in a tracked image extension.
 *
 * Built from `IMAGE_EXTENSIONS` so the tracked-format policy stays in one place —
 * adding a format later must not require remembering the two callers. The character
 * class deliberately excludes `/`, so `{{ site.url }}/img/hero.png` yields
 * `hero.png` and nothing longer.
 *
 * ⚠️ **Deliberately still space-free, and deliberately cheap.** R26 needs spaced
 * filenames found, and the obvious fix — `[\w@.\-]+(?: [\w@.\-]+){0,6}\.(ext)` — was
 * **measured at 1.7× to 5× the running time** over the three validation repos' text
 * (astro-docs: 647 ms to 3,228 ms across 15.9 MB) for **77, 0 and 90** extra tokens. The
 * repetition makes the engine try to cross a space at every word boundary and then
 * backtrack to find the extension, so the cost lands on every byte while the benefit
 * lands on a handful of matches.
 *
 * So the space handling lives in `imageFilenameCandidates`, which extends leftwards
 * **only from a match** — same candidate set, at the cost of the scan this pattern
 * always was. (g) is already failing and this runs over every byte of every unread file,
 * which is exactly the wrong place to pay five times over.
 *
 * A fresh `RegExp` per call: a `g`-flagged literal carries `lastIndex` between uses,
 * which would make results depend on what was scanned before them.
 */
export function imageFilenamePattern(): RegExp {
  const extensions = IMAGE_EXTENSIONS.map((extension) =>
    extension.slice(1).replace(/[^A-Za-z0-9]/g, '\\$&'),
  );
  return new RegExp(`[\\w@.\\-]+\\.(?:${extensions.join('|')})\\b`, 'gi');
}

/** How many space-separated words a filename may carry. Real ones use one to four. */
const MAX_SPACED_WORDS = 6;

/** The characters `imageFilenamePattern` allows inside a filename token. */
const FILENAME_CHARACTER = /[\w@.\-]/;

/**
 * Every basename an image-looking token in `text` could be naming, with its offset.
 *
 * **R26's sweep half.** `imageFilenamePattern` cannot cross a space, so an asset named
 * `Firing Practice.webp` was only ever matched as `Practice.webp` — never equal to its
 * basename, so **no mention was recorded and no hedge produced.** That is why R26's
 * misses came back as confident `dead` rather than `possibly-dead`: the adapter missed
 * the reference, and R8's sweep, whose entire job is catching what the adapter missed,
 * had the identical hole. `dead` claims *"this filename appears nowhere in your
 * codebase"*, and that held only for filenames without spaces.
 *
 * ⚠️ **Extending leftwards from a match, rather than widening the pattern.** Widening it
 * was measured at 1.7× to 5× the scan time for 0 to 90 extra tokens — see
 * `imageFilenamePattern`. Here the work happens only at the ~1,400 places a match already
 * occurred, and the candidate set is identical: walking left over ` word` runs from
 * `Practice.webp` yields `Firing Practice.webp`, and each step is yielded, so the tail
 * forms survive too.
 *
 * ⚠️ **Yielding every step is not tidiness, it is the regression guard.** Both callers
 * lowercase a token and look it up against asset basenames. If only the longest form were
 * offered, the prose `Remove workspace.png` would stop matching an asset named
 * `workspace.png` — a mention that works today would be **lost**, and `shadcn-ui` has 87
 * strings of that shape. Yielding both makes the change strictly additive.
 *
 * It lives here rather than in either caller because `scan.ts` and `sweep.ts` do the
 * identical lookup, and a hole in one of two identical lookups is exactly how this
 * defect survived §5.1.
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
}
