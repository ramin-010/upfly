/**
 * What went unread, classified by what a reader can do about it.
 *
 * Extracted from `report.ts` when a second module needed it: R72's move disclosure
 * has to name the file types a broken reference could be hiding in, and naming
 * `.woff2` there would be a lie of a particular kind — it would invite a user to go
 * looking inside a font for a path. The classification is the part that makes the
 * sentence true, so it is shared rather than copied.
 *
 * ⚠️ **The copy is the thing to avoid, not the dependency.** `isUnderPublicDir` was
 * got backwards twice in two modules before it was shared (R70); a second hand-kept
 * list of binary extensions would drift the same way, and the drift would be
 * invisible — both copies would still look obviously correct.
 */

import { compareStrings } from './paths.js';
import type { UnscannedExtension, UnscannedFile } from './types.js';

/**
 * Extensions whose contents are not text.
 *
 * Deliberately a list rather than a heuristic: guessing wrong in the *other*
 * direction would tell a user that a format no adapter reads is unreadable in
 * principle, which is exactly the kind of confident-and-wrong sentence R21 was
 * raised about. Anything not named here is assumed to be text an adapter could one
 * day read.
 */
const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  '.mp4',
  '.webm',
  '.mov',
  '.avi',
  '.mp3',
  '.wav',
  '.ogg',
  '.otf',
  '.ttf',
  '.woff',
  '.woff2',
  '.eot',
  '.ico',
  '.pdf',
  '.zip',
  '.gz',
  '.tar',
  '.wasm',
  '.node',
  '.bin',
  '.psd',
  '.sketch',
  '.db',
  '.sqlite',
]);

/** Unscanned extensions, split three ways. */
export interface UnscannedGroups {
  /** Text we could read one day. An adapter closes this group. */
  readonly adapterCould: readonly UnscannedExtension[];
  /** Not text. Nothing closes this group, and nothing should try. */
  readonly binary: readonly UnscannedExtension[];
  /** SVG, counted as an image asset *and* left unparsed. A decision, not a gap. */
  readonly svg: number;
}

/**
 * Unscanned extensions, split by what a reader can do about each.
 *
 * The distinction is not cosmetic: an adapter closes the first group, nothing closes
 * the second, and the third is a deliberate design decision rather than a gap.
 */
export function groupUnscanned(extensions: readonly UnscannedExtension[]): UnscannedGroups {
  const adapterCould: UnscannedExtension[] = [];
  const binary: UnscannedExtension[] = [];
  let svg = 0;

  for (const entry of extensions) {
    if (entry.ext === '.svg') svg += entry.fileCount;
    else if (BINARY_EXTENSIONS.has(entry.ext)) binary.push(entry);
    else adapterCould.push(entry);
  }

  return { adapterCould, binary, svg };
}

/**
 * The unread file types a literal path could be hiding in.
 *
 * 🔴 **This is the set R72's disclosure must name, and it is not simply
 * `unscannedExtensions`.** A binary file holds no path text for a move to miss, so
 * listing `.woff2` as a place a reference might have broken would send a user to read
 * a font. SVG is included: it is left unparsed and it genuinely can carry an
 * `<image href>`, which is the exact shape of reference a move would fail to repoint.
 */
export function couldHideAReference(
  extensions: readonly UnscannedExtension[],
): readonly UnscannedExtension[] {
  const groups = groupUnscanned(extensions);
  const svg = extensions.find((entry) => entry.ext === '.svg');

  // 🔴 **Most files first, not alphabetical, and that ordering is load-bearing.**
  // A caller that names only the first few truncates the tail, and on
  // `railsgirls-com` the alphabetical order put `.yml` sixth of six — so the one
  // extension that demonstrated R72 in the first place was the one hidden behind
  // *"and 1 more"*. Found by rendering it and reading it, which no test would have.
  // Ties break on extension so the order is total and the output deterministic.
  return [...groups.adapterCould, ...(svg === undefined ? [] : [svg])].sort(
    (a, b) => b.fileCount - a.fileCount || (a.ext < b.ext ? -1 : a.ext > b.ext ? 1 : 0),
  );
}

/**
 * Unread files counted by extension, sorted by extension.
 *
 * Shared rather than copied, on the same reasoning as everything else in this file: it
 * lived in `graph.ts` until R72's disclosure needed to count a **subset** of the unread
 * files. `graph.unscannedExtensions` counts them all, parse failures included, and a
 * disclosure that lists those twice tells a reader the blind spot is bigger than it is.
 */
export function countExtensions(files: readonly UnscannedFile[]): UnscannedExtension[] {
  const counts = new Map<string, number>();
  for (const file of files) counts.set(file.extension, (counts.get(file.extension) ?? 0) + 1);

  return [...counts]
    .map(([ext, fileCount]) => ({ ext, fileCount }))
    .sort((a, b) => compareStrings(a.ext, b.ext));
}
