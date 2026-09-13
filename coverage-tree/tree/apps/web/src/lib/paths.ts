/**
 * Paths that are assembled rather than written down.
 *
 * The distinction that matters: a template whose unknown part is one segment of a name
 * can still be checked against the files that exist, whereas a path built from a base
 * and a variable cannot be checked at all. Both are "not a literal"; only one of them is
 * knowable.
 */

export type ThemeMode = 'light' | 'dark' | 'sepia';

/** One reference standing for three files, all of which exist. */
export function themeImage(mode: ThemeMode): string {
  return `/theme-${mode}.png`;
}

/** The same shape with a suffix after the unknown part. */
export function tileImage(density: 1 | 2 | 3): string {
  return `/srcset/tile@${density}x.png`;
}

/** Assembled from a base and a name. Nothing static survives. */
const ASSET_BASE = '/gallery';

export function galleryImage(name: string): string {
  return ASSET_BASE + '/' + name + '.png';
}

export function galleryImageTemplate(name: string): string {
  return `${ASSET_BASE}/${name}.png`;
}

/** Built from a directory listing at runtime. */
export function fromParts(dir: string, file: string, ext: string): string {
  return [dir, file].join('/') + ext;
}

/** Two more assembled paths, so neither dynamic row reads 1 of 1. */
export function srcsetImage(width: number): string {
  return '/srcset/' + 'card-' + String(width) + '.jpg';
}

export function iconImage(size: number, base: string): string {
  return `${base}/icon-${size}.png`;
}

export function themedIcon(theme: string, size: string): string {
  return `/icons/${theme}-${size}.png`;
}

/** A literal, sitting among the assembled ones so the difference is visible. */
export const HERO = '/img/hero.jpg';
export const BANNER = '/img/banner.png';
export const TEAM = '/img/team.jpg';

/** A literal that points at nothing. */
export const MISSING = '/img/missing-from-paths.png';

/** Real files, addressed with a cache-buster and with a fragment. Both still resolve. */
export const HERO_VERSIONED = '/img/hero.jpg?v=3';
export const HERO_ANCHORED = '/img/team.jpg#face';

/** An absolute URL and a package specifier, neither of which is ours to rewrite. */
export const REMOTE = 'https://cdn.example.com/remote/paths.png';
export const PACKAGED = 'some-ui-kit/dist/emblem.png';

/** Aliases: one that maps, one that does not. */
export const ALIASED = '~/assets/img/hero.jpg';
export const UNMAPPED = '@missing/paths.png';
