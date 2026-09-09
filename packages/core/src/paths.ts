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
