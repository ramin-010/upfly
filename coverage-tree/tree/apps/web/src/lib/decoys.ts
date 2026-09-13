/**
 * Path-shaped strings that are not references.
 *
 * A tree containing only real references cannot produce a false positive, so it cannot
 * measure precision at all — only recall. Everything in this file must come back as
 * "not a live reference", and a run that rewrites any of it has corrupted a source file.
 */

// A filename inside a comment: see /gallery/hero (1).png for the original crop.
// The banner was cut from /img/banner.png at 900x300.

export const LOG_PREFIX = '[assets]';

export function reportMissing(name: string): void {
  // A path-shaped string inside a log message. Nothing on disk is named this.
  console.warn(`${LOG_PREFIX} could not load /img/not-a-real-file.png for ${name}`);
  console.warn('[assets] falling back to /gallery/also-not-real.png');
}

/** Off by one character from a file that does exist. */
export const TYPO_ONE = '/img/her.jpg';
export const TYPO_TWO = '/gallery/phot.png';
export const TYPO_THREE = '/brandd.png';

/** A real filename with an extra extension on the end — a backup, not an image. */
export const BACKUP = '/img/hero.jpg.bak';

/** Extension-shaped text that is not an extension. */
export const MIME = 'image/png';
export const FORMAT_FLAG = 'png';
export const SPRITE = 'sprite.pngx';

/** A CSS class whose name ends in an extension-like string. */
export const CLASS_NAME = 'is-png-only';

/** A query string and a fragment hanging off a name that is not on disk. */
export const WITH_QUERY = '/img/missing-query.png?v=3';
export const WITH_HASH = '/img/missing-hash.png#top';

/** A Windows-style path, which is not how anything here is addressed. */
export const WINDOWS_STYLE = 'img\\hero.jpg';

/** A glob, not a path. */
export const GLOB = '/gallery/*.png';

/** A regular expression that happens to contain an extension. */
export const IMAGE_RE = /\.(png|jpe?g|svg)$/i;

export function isImage(name: string): boolean {
  return IMAGE_RE.test(name);
}
