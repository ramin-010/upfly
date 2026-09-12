/**
 * The validation corpus: which repositories, pinned at which commit, and what each
 * one serves its root-relative paths from.
 *
 * Its own module so that reading the table costs nothing. `validate.ts` ends in a
 * top-level `await main()`, so importing the table from there would run the entire
 * validation as a side effect, and two concurrent runs writing the same output
 * directory is a failure this project has already had once.
 */

import { resolve, sep } from 'node:path';

export const VALIDATION_ROOT = 'E:/PERSONAL_PROJECTS/upfly-validation';

/**
 * Refuse to let a writing run point at the pinned corpus.
 *
 * The corpus is 394 images across five repositories pinned at specific commits, and
 * every measurement this project quotes is stated against those pins. Converting one
 * of those images would invalidate all of it SILENTLY: a converted image still reads
 * as an image and the pinned commit still checks out, so the first anyone would know
 * is a number that stopped reproducing days later.
 *
 * This has already happened once in a different form. The v2 extension converted 19
 * fixture images in place seconds after they were generated and nobody noticed for a
 * day, which is why the corpus lives outside the workspace at all. That kill switch
 * protects it from the extension. This protects it from us.
 *
 * A run against a real repository works on a copy, and this exists because a workflow
 * is followed until the night it is not. Callers that only read are not the hazard and
 * do not call this: `validate.ts` writes reports into an output directory and never
 * touches the tree.
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
   * A list because a monorepo has one per app — shadcn-ui has six, and resolving
   * against a single one produced 93 false `broken` findings (R13).
   */
  readonly publicDirs: readonly string[];
  /**
   * Run this entry with no configuration at all, as a first-time user would.
   *
   * `publicDirs` is then ignored and the convention guess applies, marked as a guess.
   * Added because every other entry in this list is hand-tuned, so the corpus could
   * not see what a stranger's first run produces.
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
    // Every `public/` in the workspace, as auto-detection would find them. There
    // are twelve, not the six a `-maxdepth 3` search turns up — the fixture apps
    // under `packages/` have their own, and leaving those out reports their
    // references broken.
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
    // The monorepo, met the way a stranger meets it. The convention guess is a single
    // `public/` at the workspace root, which this repository does not have: its public
    // directories live under `apps/*`, `packages/*` and `templates/*`.
    //
    // This is the repository where resolving a reference against a SIBLING app's
    // public directory produced 93 false `broken` findings. The ancestor-only
    // restraint that fixed it was built and measured against declared directories and
    // has never been exercised against a guess, on the repository where that class of
    // mistake actually happened.
    name: 'shadcn-ui',
    sha: '3ba91b1cc83e1bbe4ab35a422ff2a694849c5048',
    publicDirs: [],
    unconfigured: true,
  },
  {
    // R27/R28: chosen for how its files are NAMED, not for its stack. Hand-written
    // static HTML with no build step, so the project root itself is the serving root
    // — `['']` rather than a public directory, which is the case `project-root`
    // resolution exists for and the one R36 measured at 1,267 asserted references.
    name: 'railsgirls-com',
    sha: 'fa2b63c48381a04f354d976efe2fdd1d35078b9e',
    publicDirs: [''],
  },
  {
    // The same repository, met the way a stranger meets it. Hand-written static HTML
    // with no `public/` directory, so the convention guess matches nothing and every
    // root-relative path falls through to the project root. That is the bucket the
    // configured entry above cannot produce, and it is the one a first run always
    // hits, because a first run has no configuration by definition.
    name: 'railsgirls-com',
    sha: 'fa2b63c48381a04f354d976efe2fdd1d35078b9e',
    publicDirs: [''],
    unconfigured: true,
  },
  {
    // R27/R28's other half: messy filenames reached through JSX and SCSS rather than
    // raw HTML, which is the shape R26 was. Webpack serves `static/` at `/`.
    //
    // ⚠️ No saving percentage may ever be quoted off this repo: 91 of its 132 messy
    // images are `.svg`, which Upfly never converts, so it is a reference-graph
    // subject rather than a conversion one (06-validation-repos.md).
    name: 'scratch-www',
    sha: '8025bf2c0cbb5bdaff1272ed888e38deb7fae9ed',
    publicDirs: ['static'],
  },
];
