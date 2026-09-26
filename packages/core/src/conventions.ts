/**
 * Assets a framework reads by filename, with nothing referencing them.
 *
 * Next.js emits `og:image` from `app/…/opengraph-image.jpg` on the strength of the path
 * and name alone. No import, attribute or string in the repository names that file, so
 * every mechanism the engine has for finding a live asset misses it, and the audit would
 * call it `dead`: the strongest claim the tool makes, which a user may act on by deleting
 * their social preview images.
 *
 * Pure: it reads the file list `discover` produced and never touches a disk.
 */

import { compareStrings } from './paths.js';

/** A directory whose framework reads certain filenames without being told to. */
export interface ConventionRoot {
  /** Which framework's rules apply. Only Next.js today; another would add a value here. */
  readonly framework: 'next';
  /** POSIX-relative directory holding the config. `''` is the project root. */
  readonly dir: string;
}

/**
 * Why a convention keeps an asset alive.
 *
 * A sentence rather than a boolean, because it reaches the report, and naming the
 * convention explains far more than "excluded by a convention".
 */
export interface ConventionLink {
  readonly asset: string;
  readonly reason: string;
}

const NEXT_CONFIG = /^next\.config\.(?:js|mjs|cjs|ts|mts|cts)$/;

/**
 * The reserved names, and the trailing-digit rule that goes with them.
 *
 * Next allows `icon1.png`, `icon2.png` and so on when a route needs several, so the
 * digits are part of the convention. Matching only the bare name would report those
 * files as `dead`.
 */
const NEXT_CONVENTION_NAMES = ['opengraph-image', 'twitter-image', 'icon', 'apple-icon'] as const;
const NEXT_CONVENTION_NAME = new RegExp(`^(${NEXT_CONVENTION_NAMES.join('|')})\\d*$`);

/**
 * Every directory that is a framework app root, from the files `discover` listed.
 *
 * Per directory, not once per project: a monorepo can hold one `next.config.*` per app,
 * and the one that governs `apps/v4/app/…` is `apps/v4/next.config.mjs`.
 */
export function detectConventionRoots(files: readonly string[]): readonly ConventionRoot[] {
  const roots: ConventionRoot[] = [];

  for (const file of files) {
    const slash = file.lastIndexOf('/');
    const name = slash === -1 ? file : file.slice(slash + 1);
    if (!NEXT_CONFIG.test(name)) continue;
    roots.push({ framework: 'next', dir: slash === -1 ? '' : file.slice(0, slash) });
  }

  return roots.sort((a, b) => compareStrings(a.dir, b.dir));
}

/**
 * Whether a framework reads this asset by name, and why.
 *
 * The path shape is the whole predicate: under an app root, inside that root's
 * `app/` directory at any depth, named one of the reserved names. Next applies these
 * only inside `app/`, so `public/twitter-image.png` is an ordinary public asset, and
 * treating it as one keeps this from suppressing real findings.
 */
export function conventionLinkFor(
  asset: string,
  roots: readonly ConventionRoot[],
): ConventionLink | null {
  for (const root of roots) {
    const prefix = root.dir === '' ? '' : `${root.dir}/`;
    if (!asset.startsWith(prefix)) continue;

    const within = asset.slice(prefix.length);
    const segments = within.split('/');

    // `app/` or `src/app/`: Next supports both layouts.
    const router =
      segments[0] === 'app' ? 1 : segments[0] === 'src' && segments[1] === 'app' ? 2 : 0;
    if (router === 0 || segments.length < router + 1) continue;

    const file = segments[segments.length - 1] ?? '';
    const dot = file.lastIndexOf('.');
    if (dot <= 0) continue;
    if (!NEXT_CONVENTION_NAME.test(file.slice(0, dot))) continue;

    return {
      asset,
      // No path here: the report prints this after the asset's own path.
      reason: 'Next.js reads this from its route segment by filename — nothing references it',
    };
  }

  return null;
}
