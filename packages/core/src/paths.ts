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
 * A fresh `RegExp` per call: a `g`-flagged literal carries `lastIndex` between uses,
 * which would make results depend on what was scanned before them.
 */
export function imageFilenamePattern(): RegExp {
  const extensions = IMAGE_EXTENSIONS.map((extension) =>
    extension.slice(1).replace(/[^A-Za-z0-9]/g, '\\$&'),
  );
  return new RegExp(`[\\w@.\\-]+\\.(?:${extensions.join('|')})\\b`, 'gi');
}
