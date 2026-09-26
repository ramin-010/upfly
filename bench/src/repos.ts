/**
 * The validation corpus: which repositories, pinned at which commit, and what each
 * one serves its root-relative paths from.
 *
 * Its own module so that reading the table costs nothing. `validate.ts` ends in a
 * top-level `await main()`, so importing the table from there would run the whole
 * validation, and write its output directory, as a side effect.
 */

import { resolve, sep } from 'node:path';

export const VALIDATION_ROOT = 'E:/PERSONAL_PROJECTS/upfly-validation';

/**
 * Refuse to let a writing run point at the pinned corpus.
 *
 * Every measurement this project quotes is stated against the pinned commits. A
 * converted image still reads as an image, so converting one would invalidate them with
 * no error: the first sign would be a number that no longer reproduces.
 *
 * Keeping the corpus outside the workspace protects it from the v2 VS Code extension,
 * which converts images in place. This protects it from the bench's own writing runs,
 * which must work on a copy. Callers that only read do not call it: `validate.ts` writes
 * reports into an output directory and never touches the tree.
 */
export function refuseValidationCorpus(root: string): void {
  const target = normaliseForCompare(root);
  const corpus = normaliseForCompare(VALIDATION_ROOT);

  // Resolved absolute paths rather than the strings as given, so a relative path or
  // one walking back in through `..` cannot slip past a prefix test.
  if (target !== corpus && !target.startsWith(`${corpus}${sep}`)) return;

  throw new Error(
    `Refusing to run a writing operation inside the pinned validation corpus: ${resolve(root)}. Every measurement in this project is stated against those commits, and converting an image there would invalidate them without producing an error. Copy the repository somewhere else and run against the copy.`,
  );
}

/**
 * Case-folded, because a guard that a different capitalisation walks past is not one.
 *
 * Folded on every platform rather than only on Windows. On a case-sensitive
 * filesystem this can only refuse a path it did not strictly have to, and refusing one
 * directory too many costs somebody a rename while missing one costs the corpus.
 */
function normaliseForCompare(path: string): string {
  return resolve(path).toLowerCase();
}

export interface RepoSpec {
  readonly name: string;
  readonly sha: string;
  /**
   * Every directory a root-relative `/hero.png` may be served from.
   *
   * A list because a monorepo has one per app: resolving every reference against a
   * single one reports the other apps' references as `broken`.
   */
  readonly publicDirs: readonly string[];
  /**
   * Run this entry with no configuration at all, as a first-time user would.
   *
   * The engine then ignores `publicDirs` and decides the serving roots as a first run
   * does, reporting them as not declared; only the independent check in `verify.ts`
   * still reads it. The other entries are hand-tuned, so without these the corpus would
   * never see what a stranger's first run produces.
   */
  readonly unconfigured?: boolean;
}

/**
 * How this run is named in the artefacts.
 *
 * Separate from `name`, which is the directory on disk, because one repository can
 * appear twice under two configurations and the two runs must not write over each
 * other's reports.
 */
export function labelOf(repo: RepoSpec): string {
  return repo.unconfigured === true ? `${repo.name}-unconfigured` : repo.name;
}

export const REPOS: readonly RepoSpec[] = [
  { name: 'astro-docs', sha: 'cf14d7dd900c261c5c55079fca5e878945c9a96d', publicDirs: ['public'] },
  { name: 'eleventy-docs', sha: '028e2555848ea8a08ece1ce268ee7d1335271427', publicDirs: ['src'] },
  {
    name: 'shadcn-ui',
    sha: '3ba91b1cc83e1bbe4ab35a422ff2a694849c5048',
    // Every `public/` in the workspace, as detection finds them: twelve, not the six a
    // `-maxdepth 3` search turns up. The fixture apps under `packages/` have their own,
    // and leaving those out reports their references broken.
    publicDirs: [
      'apps/v4/public',
      'packages/shadcn/test/fixtures/frameworks/remix-indie-stack/public',
      'packages/shadcn/test/fixtures/frameworks/remix/public',
      'packages/shadcn/test/fixtures/frameworks/vite/public',
      'packages/shadcn/test/fixtures/vite-with-tailwind/public',
      'templates/astro-app/public',
      'templates/astro-monorepo/apps/web/public',
      'templates/next-app/public',
      'templates/react-router-app/public',
      'templates/start-app/public',
      'templates/start-monorepo/apps/web/public',
      'templates/vite-app/public',
    ],
  },
  {
    // The monorepo, met the way a stranger meets it: twelve public directories under
    // `apps/*`, `packages/*` and `templates/*`. A root-relative reference resolves only
    // against the serving roots of the app its file belongs to, because another app's can
    // link it to an asset its own app does not serve. This checks that restraint when the
    // roots were worked out rather than declared.
    name: 'shadcn-ui',
    sha: '3ba91b1cc83e1bbe4ab35a422ff2a694849c5048',
    publicDirs: [],
    unconfigured: true,
  },
  {
    // Chosen for how its files are named, not for its stack. Hand-written static HTML
    // with no build step, so the project root itself is the serving root: `['']` rather
    // than a public directory, the case `project-root` resolution exists for.
    name: 'railsgirls-com',
    sha: 'fa2b63c48381a04f354d976efe2fdd1d35078b9e',
    publicDirs: [''],
  },
  {
    // The same repository, met the way a stranger meets it. Hand-written static HTML
    // with no `public/` directory, so detection finds no serving root and every
    // root-relative path falls through to the project root. That is the bucket the
    // configured entry above cannot produce, and the one a first run here always hits.
    name: 'railsgirls-com',
    sha: 'fa2b63c48381a04f354d976efe2fdd1d35078b9e',
    publicDirs: [''],
    unconfigured: true,
  },
  {
    // Messy filenames again, reached through JSX and SCSS rather than raw HTML. Webpack
    // serves `static/` at `/`.
    //
    // Quote no saving from it: 91 of its 132 messy images are `.svg`, which Upfly does
    // not convert, so it tests the reference graph rather than conversion.
    name: 'scratch-www',
    sha: '8025bf2c0cbb5bdaff1272ed888e38deb7fae9ed',
    publicDirs: ['static'],
  },
];
