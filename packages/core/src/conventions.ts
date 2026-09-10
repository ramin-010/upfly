/**
 * Assets a framework reads **by filename**, with nothing referencing them.
 *
 * Next.js emits `og:image` from `app/…/opengraph-image.jpg` on the strength of the
 * path and the name alone. No import, no attribute, no string anywhere in the
 * repository names that file — so every mechanism the engine has for deciding an
 * asset is alive is structurally unable to see it. R8, R10, R14 and R15 each widened
 * *where we look for a string*; none of them can reach a case where no string exists.
 *
 * Found by the §5.1(d) pass on `shadcn-ui`, which reported
 * `apps/v4/app/(app)/(styles)/sera/opengraph-image.jpg` and its `twitter-image.jpg`
 * sibling as confidently `dead`. Both are alive. And the independent oracle written
 * to check that pass agreed with the engine on one of them, because it is a string
 * searcher too — which is the argument for this module existing rather than the gap
 * being documented: `dead` is the strongest claim the tool makes, it means *delete
 * this*, and a user who obeys silently loses their social preview images.
 *
 * **This is not the engine's first piece of framework knowledge.** `resolve.ts`
 * defaults `publicDirs` to `['public']`, which is a Next/Vite/CRA convention rather
 * than a fact — `plain-html` needs `''` and `eleventy` needs `'src'` — and R13 taught
 * the resolver that an app root is a directory holding a `package.json` beside a
 * public directory. This is that same knowledge one filename deeper.
 *
 * Pure, and deliberately so: it is handed the file list `discover` already produced
 * and never looks at a disk.
 */

import { compareStrings } from './paths.js';

/** A directory whose framework reads certain filenames without being told to. */
export interface ConventionRoot {
  /** Which framework's rules apply. One today; the shape is what stops it being two. */
  readonly framework: 'next';
  /** POSIX-relative directory holding the config. `''` is the project root. */
  readonly dir: string;
}

/**
 * Why an asset is alive, or `null` if no convention claims it.
 *
 * A sentence rather than a boolean, because rule 9 makes this reach the report and
 * "excluded by a convention" is a much worse line than naming the convention.
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
 * digits are part of the convention rather than a coincidence — matching only the
 * bare name would leave exactly the repositories that use the feature most broken.
 */
const NEXT_CONVENTION_NAMES = ['opengraph-image', 'twitter-image', 'icon', 'apple-icon'] as const;
const NEXT_CONVENTION_NAME = new RegExp(`^(${NEXT_CONVENTION_NAMES.join('|')})\\d*$`);

/**
 * Every directory that is a framework app root, from the files `discover` listed.
 *
 * Per directory, not once per project: `shadcn-ui` holds **seventeen** `next.config.*`
 * files and the one that matters for `apps/v4/app/…` is `apps/v4/next.config.mjs`.
 * A project-root-only check would have found nothing there and left the ruling inert.
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
 * `app/` directory at any depth, named one of the reserved names. Next only applies
 * these inside `app/`, so `public/twitter-image.png` is **not** an instance — it is
 * an ordinary public asset, and treating it as one keeps this from quietly
 * suppressing real findings.
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

    // `app/` or `src/app/`. Next supports both layouts and `shadcn-ui` contains six
    // `src/app` directories, so omitting it would have left the mechanism silently
    // half-working on the very repository that motivated it.
    const router =
      segments[0] === 'app' ? 1 : segments[0] === 'src' && segments[1] === 'app' ? 2 : 0;
    if (router === 0 || segments.length < router + 1) continue;

    const file = segments[segments.length - 1] ?? '';
    const dot = file.lastIndexOf('.');
    if (dot <= 0) continue;
    if (!NEXT_CONVENTION_NAME.test(file.slice(0, dot))) continue;

    return {
      asset,
      // Deliberately does not repeat the path: the report prints this after the
      // asset's own path, and reading the rendered line back showed it twice.
      reason: 'Next.js reads this from its route segment by filename — nothing references it',
    };
  }

  return null;
}
