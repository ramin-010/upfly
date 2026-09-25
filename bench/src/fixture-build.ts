/**
 * The Phase 2 exit criterion, made executable — and made able to fail first.
 *
 * The build plan's exit criterion reads: *"`optimize --apply` on all fixtures
 * produces a tree whose build still passes — each fixture has a `build` script that
 * runs in CI after optimization. That test is the product's promise."*
 *
 * ⚠️ **It had never run.** The five fixtures declared `build` scripts and **not one
 * declared a dependency**, so `astro build` could not have started; there was no
 * lockfile; and `ci.yml`'s `build` job builds the packages, not the fixtures. A gate
 * that has never run is indistinguishable from a gate that passes (R42).
 *
 * So this harness is deliberately built **before** the transaction it exists to
 * judge, and its first job is not to pass. It is to **fail on demand**: every
 * fixture is checked once untouched, then once per reference class with that class
 * of reference deliberately pointed at a file that does not exist. An instrument
 * that cannot tell those two trees apart is reported as **blind** for that class
 * rather than quietly counted as a pass.
 *
 * That ordering matters for a reason beyond tidiness: the harness is finished and
 * calibrated while there is no `optimize` to tune it against, so it cannot have been
 * shaped — consciously or not — to let our own transaction through.
 *
 * **Nothing here uses the engine.** Not `discover`, not the resolver, not an
 * adapter. The whole value of a framework build as an oracle is that it is somebody
 * else's idea of what a reference is; routing it through ours would reproduce
 * §5.1(j)'s blind instrument, where the thing doing the checking shared the defect
 * it was checking for.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { argv, exit, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import type { PublicPolicy } from 'upfly-core';
// The one place this file touches the engine, and it is the subject rather than an
// instrument. The build and the link check stay engine-free on purpose: the value of
// a framework build as an oracle is that it is somebody else's idea of a reference.
import { optimizeTree } from './engine-run.js';

const FIXTURES_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures');

/**
 * Where build trees are materialised: a sibling of the repository, never inside it.
 *
 * ⚠️ **Not the OS temp directory, and the reason is measured.** On Windows the temp
 * directory is on `C:` while this checkout is on `E:`, and `node_modules` is reached
 * by a junction. Next.js resolves its client entry points as a path *relative* to
 * the build directory — and there is no relative path between two volumes, so it
 * emitted `./E:/…/next/dist/client/next.js` and failed with *"Module not found"* on
 * an untouched tree. Vite, Astro and Eleventy were unaffected, which is exactly how
 * a trap like this survives: four of five instruments say the setup is fine.
 * Same-volume by construction removes it rather than documenting it.
 *
 * ⚠️ **And never inside the workspace**, whatever the volume: every fixture has a
 * `public/` directory, and the v2 extension converts images in any in-repo `public/`
 * in place and deletes the originals. It destroyed 19 fixture files that way.
 */
const BUILD_ROOT = resolve(FIXTURES_ROOT, '../../../upfly-fixture-builds');

/** How long one build may take before it is reported as a timeout rather than a pass. */
const BUILD_TIMEOUT_MS = 180_000;

/**
 * What an instrument says about a tree.
 *
 * Deliberately not `pass`/`fail`: those words read ambiguously once a *failing*
 * build is the desired outcome. `intact` and `broken` describe the tree, so
 * "the negative control expects `broken`" says what it means.
 */
type Verdict = 'intact' | 'broken';

interface Outcome {
  readonly verdict: Verdict;
  /** Enough output to read a surprise, rather than a bare boolean. */
  readonly detail: string;
}

/**
 * A class of reference, and the column it occupies in the coverage table.
 *
 * These are the shapes the planner will rewrite, so "can the build see this class?"
 * is the question that decides how much the exit criterion is actually worth.
 */
type ReferenceClass =
  /** `import logo from './logo.png'` — the bundler resolves it. */
  | 'bundled-import'
  /** `url('./texture.png')` in a stylesheet the bundler processes. */
  | 'bundled-css-url'
  /** `/hero.png`, served from a public directory and copied verbatim. */
  | 'public-root-relative'
  /** A `srcset`/`image-set` candidate — a path inside a comma-separated list. */
  | 'srcset-candidate';

/**
 * One deliberate break.
 *
 * ⚠️ `find` must occur **exactly once** in `file` or the mutation throws. Without
 * that check a stale or mistyped `find` would change nothing, the build would
 * correctly stay green, and the harness would record the instrument as *blind* to a
 * class it can in fact see — a wrong answer that looks like a measurement. The
 * assertion is what makes a `blind` verdict mean something.
 */
interface Mutation {
  readonly referenceClass: ReferenceClass;
  /** POSIX-relative to the fixture root. */
  readonly file: string;
  readonly find: string;
  readonly replace: string;
}

interface FixtureSpec {
  readonly name: string;
  /**
   * The `scripts.build` command, or `null` for a tree that is its own output.
   *
   * `plain-html` is the `null` case and it is not an oversight: a static tree has no
   * build step to pass, and inventing one would destroy the thing the fixture exists
   * to represent. R42 condition 2 forbids letting that become a silent exclusion, so
   * it is checked by the link instrument instead and appears in the table like
   * everything else.
   */
  readonly buildScript: string | null;
  /**
   * Where the build emits the shipped site, relative to the tree root.
   *
   * ⚠️ **The link check runs here and not on the source tree**, and the first run of
   * this harness is why. Pointed at a framework's *source*, it reported every
   * baseline BROKEN: in a source tree `/favicon.svg` is served from `public/`, so
   * resolving it against the tree root finds nothing and every verdict beneath it
   * becomes meaningless. In the emitted tree `/x` means exactly what it says — the
   * site root — and the emitted tree is also the only thing a visitor ever loads.
   *
   * The baseline control caught this before a single verdict was quoted, which is
   * the entire argument for running an instrument against a tree you already know
   * the answer for.
   */
  readonly outputDir: string;
  /**
   * The serving root this project declares, when it declares one.
   *
   * eleventy is the case. It serves from `src` via `addPassthroughCopy`, which is a
   * source directory rather than a serving root by convention, so no name-based
   * detector should claim it and R51 ruled that the answer is to tell the user to
   * declare it. A real eleventy user declares it once. Leaving this fixture in the
   * undetected state would spend the only write-path test it has on demonstrating a
   * failure that unit tests and eleventy-docs already cover.
   */
  readonly publicDirs?: readonly string[];
  readonly mutations: readonly Mutation[];
}

/**
 * The fixtures, and the exact strings the negative control breaks.
 *
 * Every `find` below was chosen by **reading the fixture**, not by asking the engine
 * what it found there. §5.1(i)'s rule — an assertion whose expected value came from
 * the code cannot vouch for the code — applies to a mutation just as much as to an
 * expectation.
 */
const FIXTURES: readonly FixtureSpec[] = [
  {
    name: 'vite-react',
    buildScript: 'vite build',
    outputDir: 'dist',
    mutations: [
      {
        referenceClass: 'bundled-import',
        file: 'src/App.jsx',
        find: "'./assets/logo.png'",
        replace: "'./assets/logo-broken-by-harness.png'",
      },
      {
        referenceClass: 'bundled-css-url',
        file: 'src/index.css',
        find: "url('./assets/texture.png')",
        replace: "url('./assets/texture-broken-by-harness.png')",
      },
      {
        referenceClass: 'public-root-relative',
        file: 'src/App.jsx',
        find: '"/screenshot.png"',
        replace: '"/screenshot-broken-by-harness.png"',
      },
      {
        referenceClass: 'srcset-candidate',
        file: 'src/App.jsx',
        find: '/photos/wide@2x.jpg 2x',
        replace: '/photos/wide@2x-broken-by-harness.jpg 2x',
      },
    ],
  },
  {
    name: 'astro',
    buildScript: 'astro build',
    outputDir: 'dist',
    mutations: [
      {
        referenceClass: 'bundled-import',
        file: 'src/pages/index.astro',
        find: "'../assets/logo.png'",
        replace: "'../assets/logo-broken-by-harness.png'",
      },
      {
        referenceClass: 'bundled-css-url',
        file: 'src/pages/index.astro',
        find: "url('/texture.png')",
        replace: "url('/texture-broken-by-harness.png')",
      },
      {
        referenceClass: 'public-root-relative',
        file: 'src/pages/index.astro',
        find: '"/banner.png"',
        replace: '"/banner-broken-by-harness.png"',
      },
    ],
  },
  {
    name: 'next-app',
    buildScript: 'next build',
    outputDir: 'out',
    mutations: [
      {
        referenceClass: 'bundled-import',
        file: 'app/page.tsx',
        find: "'../public/avatar.png'",
        replace: "'../public/avatar-broken-by-harness.png'",
      },
      {
        referenceClass: 'bundled-css-url',
        file: 'app/globals.css',
        find: "url('/pattern.png')",
        replace: "url('/pattern-broken-by-harness.png')",
      },
      {
        referenceClass: 'public-root-relative',
        // Qualified by the alt text because `"/hero.png"` itself occurs twice in
        // this file -- caught by the exactly-once assertion on the first run, which
        // is the assertion earning its place.
        file: 'app/page.tsx',
        find: '"/hero.png" alt="Hero again"',
        replace: '"/hero-broken-by-harness.png" alt="Hero again"',
      },
      {
        referenceClass: 'srcset-candidate',
        file: 'app/page.tsx',
        find: '/hero@2x.png 2x',
        replace: '/hero@2x-broken-by-harness.png 2x',
      },
    ],
  },
  {
    name: 'eleventy',
    buildScript: 'eleventy',
    outputDir: '_site',
    // Declared, because eleventy's `src` is a source directory rather than a serving
    // root and no name-based detector should claim it (R51).
    publicDirs: ['src'],
    mutations: [
      {
        referenceClass: 'public-root-relative',
        file: 'src/index.njk',
        find: '"/img/logo.png"',
        replace: '"/img/logo-broken-by-harness.png"',
      },
      {
        referenceClass: 'bundled-css-url',
        file: 'src/css/site.css',
        find: "url('/img/texture.png')",
        replace: "url('/img/texture-broken-by-harness.png')",
      },
    ],
  },
  {
    name: 'plain-html',
    buildScript: null,
    outputDir: '.',
    mutations: [
      {
        referenceClass: 'public-root-relative',
        file: 'index.html',
        find: '"images/logo.png"',
        replace: '"images/logo-broken-by-harness.png"',
      },
      {
        referenceClass: 'bundled-css-url',
        file: 'css/site.css',
        find: 'url(../images/texture.png)',
        replace: 'url(../images/texture-broken-by-harness.png)',
      },
      {
        referenceClass: 'srcset-candidate',
        file: 'index.html',
        find: 'images/hero@2x.jpg 2x',
        replace: 'images/hero@2x-broken-by-harness.jpg 2x',
      },
    ],
  },
];

/**
 * A reference the fixtures declare dangling on purpose.
 *
 * The same convention `fixture-integrity.test.ts` uses, and for the same reason: a
 * deliberate dangling reference has to announce itself in its own name or it is
 * indistinguishable from the accident these checks exist to catch.
 */
const DELIBERATE = /missing-on-purpose|does-not-exist/;

/** Dependency stores, build outputs and caches: what a project keeps out of git. */
const BUILD_ARTEFACTS = [
  'node_modules',
  'dist',
  '_site',
  '.next',
  'out',
  'build',
  '.astro',
  '.cache',
];

/**
 * Directories never copied into a build tree, nor walked by the link check: the above, plus
 * git's folder and Upfly's, which the command-line runs below create.
 */
const NEVER_COPY = new Set([...BUILD_ARTEFACTS, '.git', '.upfly']);

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

/**
 * Run the fixture's own build and let its exit code be the verdict.
 *
 * ⚠️ The exit code is read from the spawned process directly. Reading it through a
 * shell pipe returns the *pipe's* status — `vite build | tail` exits 0 on a build
 * that failed — which is the single cheapest way to build a harness that always
 * passes. This was confirmed by hand before the harness was written: vite exits 1
 * on an unresolvable import and 0 through a pipe.
 */
async function runBuild(root: string, script: string): Promise<Outcome> {
  const binDir = join(root, 'node_modules', '.bin');
  const result = await spawnCapture(script, root, binDir);

  if (result.timedOut) {
    return { verdict: 'broken', detail: `timed out after ${BUILD_TIMEOUT_MS} ms` };
  }
  return {
    verdict: result.code === 0 ? 'intact' : 'broken',
    detail: `exit ${result.code}\n${tail(result.output, 12)}`,
  };
}

interface SpawnResult {
  readonly code: number | null;
  readonly output: string;
  readonly timedOut: boolean;
}

function spawnCapture(script: string, cwd: string, binDir: string): Promise<SpawnResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(script, {
      cwd,
      shell: true,
      env: {
        ...process.env,
        PATH: `${binDir}${sep === '\\' ? ';' : ':'}${process.env.PATH ?? ''}`,
      },
    });

    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, BUILD_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, output, timedOut });
    });
  });
}

/**
 * Check every local path named by an HTML or CSS file in the tree.
 *
 * This is the instrument for a tree with no build step, and it is written to be
 * **over-inclusive on purpose**. It scans text for reference shapes rather than
 * parsing a document model, so it may flag something that is not really a
 * reference. That error direction is the right one here and it is the project's
 * standing asymmetry applied to an instrument: a false alarm costs five minutes of
 * reading, while a missed dangling reference is the exact failure the exit
 * criterion exists to detect.
 *
 * It shares no code with the engine, so an engine that cannot see a reference class
 * cannot make this blind to it too.
 */
async function runLinkCheck(root: string): Promise<Outcome> {
  const dangling: string[] = [];
  for (const file of await walk(root)) dangling.push(...(await danglingIn(root, file)));
  dangling.sort();
  return {
    verdict: dangling.length === 0 ? 'intact' : 'broken',
    detail:
      dangling.length === 0
        ? 'every local path resolves'
        : `${dangling.length} dangling:\n  ${dangling.join('\n  ')}`,
  };
}

/** Every local path-shaped string worth checking, from `src`, `href`, `srcset` and `url()`. */
function candidatePaths(text: string): string[] {
  const found: string[] = [];

  const attribute = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  for (const match of text.matchAll(attribute)) add(found, match[1]);

  // `srcset` and `image-set` are comma-separated candidate lists, where each entry
  // is a path followed by an optional descriptor. Splitting is what makes the 2x
  // variant visible at all — checking the attribute whole would resolve nothing.
  const list = /\b(?:srcset|image-set)\s*[=(]\s*["']?([^"'>)]+)/gi;
  for (const match of text.matchAll(list)) {
    for (const candidate of (match[1] ?? '').split(',')) {
      const path = candidate
        .trim()
        .split(/\s+/)[0]
        ?.replace(/^["']|["']$/g, '');

      // ⚠️ `image-set()` has two legal spellings and this scanner only reads one of
      // them. `image-set("a.png" 1x, …)` is a comma-separated list of strings, which
      // is what the pattern above was written for; `image-set(url("a.png") 1x, …)`
      // wraps each candidate in `url()`, and against that the capture stops at the
      // first quote and yields the literal token `url(` — a path that names nothing,
      // reported as dangling on a tree where nothing is wrong.
      //
      // It is skipped rather than parsed because the `url()` scanner below already
      // reads that spelling completely, so nothing is lost: this drops a tokenizer
      // artefact, not a reference. Found by the eleventy baseline the moment the
      // fixture gained an `image-set(url(…))` for R58, which is the loud-and-blocking
      // behaviour a baseline failure is supposed to have — and because that fixture
      // now carries the spelling, reverting this fix turns the baseline red again
      // rather than going unnoticed.
      if (path?.includes('url(')) continue;

      add(found, path);
    }
  }

  const url = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
  for (const match of text.matchAll(url)) add(found, match[1]);

  return found;
}

/**
 * Every local path named by one file that does not resolve on disk.
 *
 * Split out of {@link runLinkCheck} so each function does one thing: this one knows
 * how a single file names assets, that one knows how to walk a tree.
 */
async function danglingIn(root: string, file: string): Promise<string[]> {
  const extension = file.slice(file.lastIndexOf('.')).toLowerCase();
  const markup = extension === '.html' || extension === '.css';
  const script = extension === '.js' || extension === '.mjs';
  if (!markup && !script) return [];

  const text = await readFile(join(root, file), 'utf8');
  const active = extension === '.html' ? stripHtmlComments(text) : stripCssComments(text);
  const found: string[] = [];

  for (const rawPath of markup ? candidatePaths(active) : bundledAssetPaths(active)) {
    if (DELIBERATE.test(rawPath)) continue;

    const target = rawPath.startsWith('/')
      ? join(root, rawPath.slice(1))
      : join(root, dirname(file), rawPath);

    if (!existsSync(target)) found.push(`${file} -> ${rawPath}`);
  }
  return found;
}

/**
 * Asset paths inside an emitted JavaScript bundle.
 *
 * ⚠️ **The first version of this harness had no such scanner, and reported the
 * link check BLIND to `/screenshot.png` and to both `srcset` candidates.** It was
 * not blind — it was looking in the wrong files. A bundler compiles JSX into
 * `assets/index-<hash>.js`, so in the *emitted* tree a reference written in a
 * component no longer lives in any HTML or CSS file. Scanning only markup meant the
 * instrument could not see the single most common shape the planner rewrites.
 *
 * Matching is on the **path shape wherever it appears**, not on whole quoted
 * strings, because a compiled `srcSet` is one string holding two paths and a
 * descriptor (`"/photos/wide.jpg 1x, /photos/wide@2x.jpg 2x"`) — a whole-string
 * match sees neither. Restricting to known asset extensions is what keeps that
 * loose match quiet inside a minified bundle, and it is the same scope the product
 * itself operates in.
 */
function bundledAssetPaths(text: string): string[] {
  const found: string[] = [];
  const asset = /[./][A-Za-z0-9_@./+-]*\.(?:png|jpe?g|gif|svg|webp|avif|ico)\b/gi;
  for (const match of text.matchAll(asset)) add(found, match[0]);
  return found;
}

/** Keep only paths that name a file in this tree. */
function add(found: string[], candidate: string | undefined): void {
  if (candidate === undefined) return;
  const value = candidate.trim();
  if (value === '') return;
  // A scheme, a protocol-relative URL, a data URI, a fragment or a template
  // expression names something this tree does not contain.
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return;
  if (value.startsWith('//') || value.startsWith('#') || value.startsWith('?')) return;
  if (value.includes('{{') || value.includes('${')) return;
  found.push(value.split('#')[0]?.split('?')[0] ?? value);
}

function stripHtmlComments(text: string): string {
  // Replaced with spaces of identical length so nothing downstream depends on
  // offsets shifting — the same move the engine's masker makes, arrived at
  // independently rather than shared, because sharing it would couple this
  // instrument to the thing it audits.
  return text.replace(/<!--[\s\S]*?-->/g, (match) => ' '.repeat(match.length));
}

function stripCssComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (match) => ' '.repeat(match.length));
}

// ---------------------------------------------------------------------------
// Running one tree
// ---------------------------------------------------------------------------

/**
 * Copy a fixture into the OS temp directory and junction its dependencies.
 *
 * ⚠️ **Never build in the fixture tree itself.** Two independent reasons, both
 * already paid for once: the v2 extension converts images inside any in-repo
 * `public/` and deletes the originals — it destroyed 19 fixture files that way —
 * and `_site/`, eleventy's output, is **not** in `DEFAULT_IGNORED_DIRECTORIES`, so a
 * build left in place would put a second copy of every image into the tree that
 * `fixture-integrity.test.ts` and `fixture-oracle.test.ts` walk.
 *
 * `node_modules` is junctioned rather than copied: pnpm's links are relative into
 * the workspace store, so a copy would arrive broken. Verified before this was
 * written — a junctioned copy builds to byte-identical output hashes.
 */
async function materialise(fixture: FixtureSpec): Promise<string> {
  await mkdir(BUILD_ROOT, { recursive: true });
  const root = await mkdtemp(join(BUILD_ROOT, `${fixture.name}-`));
  await copyInto(fixture, root);
  return root;
}

/** The copy itself, into a folder that exists or is created here. */
async function copyInto(fixture: FixtureSpec, root: string): Promise<void> {
  const source = join(FIXTURES_ROOT, fixture.name);

  await cp(source, root, {
    recursive: true,
    filter: (entry) => !NEVER_COPY.has(entry.slice(entry.lastIndexOf(sep) + 1)),
  });

  const dependencies = join(source, 'node_modules');
  if (existsSync(dependencies)) {
    await symlink(dependencies, join(root, 'node_modules'), 'junction');
  }
}

/**
 * Apply one break, insisting it actually changed the file.
 *
 * @throws if `find` does not occur exactly once — see {@link Mutation}.
 */
async function applyMutation(root: string, mutation: Mutation): Promise<void> {
  const path = join(root, mutation.file);
  const before = await readFile(path, 'utf8');
  const occurrences = before.split(mutation.find).length - 1;

  if (occurrences !== 1) {
    throw new Error(
      `${mutation.file}: expected exactly one occurrence of ${JSON.stringify(mutation.find)}, found ${occurrences}. A mutation that changes nothing would report the instrument as blind to a class it can in fact see.`,
    );
  }
  await writeFile(path, before.replace(mutation.find, mutation.replace), 'utf8');
}

/**
 * Check a tree with every instrument the fixture has.
 *
 * Order matters: the build runs first because it is what *produces* the tree the
 * link check reads. When the build fails there is no emitted site to check, so the
 * link check is recorded as not run rather than as a verdict — a missing output
 * directory is not evidence that references are fine, and calling it `broken` would
 * double-count a failure the build already reported.
 */
async function check(root: string, fixture: FixtureSpec): Promise<Map<string, Outcome>> {
  const outcomes = new Map<string, Outcome>();
  let built = true;

  if (fixture.buildScript !== null) {
    const outcome = await runBuild(root, fixture.buildScript);
    outcomes.set('build', outcome);
    built = outcome.verdict === 'intact';
  }

  const emitted = join(root, fixture.outputDir);
  if (built && existsSync(emitted)) {
    outcomes.set('link-check', await runLinkCheck(emitted));
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

interface Row {
  readonly fixture: string;
  readonly instrument: string;
  readonly referenceClass: ReferenceClass;
  /** `true` when the instrument reported the deliberately broken tree as broken. */
  readonly sighted: boolean;
  readonly detail: string;
}

/**
 * The control: check the untouched tree and report anything it says is wrong.
 *
 * A fixture whose *unmodified* tree does not check out cannot serve as an oracle for
 * anything — an instrument that reports every tree broken would score `sighted` on
 * all four classes while seeing none of them. So a baseline failure is a **harness**
 * failure, loud and blocking, rather than a finding about the fixture.
 *
 * It has already earned that status twice: it caught the link check being pointed at
 * source trees instead of emitted ones, and it caught the eleventy fixture shipping a
 * stylesheet its own config never copied.
 */
async function runBaseline(fixture: FixtureSpec): Promise<string[]> {
  const failures: string[] = [];
  const root = await materialise(fixture);
  try {
    for (const [instrument, outcome] of await check(root, fixture)) {
      const ok = outcome.verdict === 'intact';
      stdout.write(`  baseline ${instrument.padEnd(11)} ${ok ? 'intact' : 'BROKEN'}\n`);
      if (!ok) failures.push(`${fixture.name}/${instrument}: ${outcome.detail}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  return failures;
}

/** Break one reference class and record what each instrument made of it. */
async function runMutation(fixture: FixtureSpec, mutation: Mutation): Promise<Row[]> {
  const rows: Row[] = [];
  const root = await materialise(fixture);
  try {
    await applyMutation(root, mutation);
    for (const [instrument, outcome] of await check(root, fixture)) {
      const sighted = outcome.verdict === 'broken';
      rows.push({
        fixture: fixture.name,
        instrument,
        referenceClass: mutation.referenceClass,
        sighted,
        detail: outcome.detail,
      });
      stdout.write(
        `  ${mutation.referenceClass.padEnd(21)} ${instrument.padEnd(11)} ${sighted ? 'sighted' : 'BLIND'}\n`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  return rows;
}

/**
 * The exit criterion itself: optimise a fixture, then check what it produced.
 *
 * R43's rewrite of the criterion is `optimize --apply` on all fixtures followed by
 * BOTH the build passing AND a link check over the emitted tree finding nothing
 * broken. The link check is the primary of the two: measured across the 16
 * (fixture, reference class) pairs, the build sees 3 and the link check sees 13.
 *
 * The instruments are the ones the baseline and the negative controls already use, on
 * trees materialised the same way, which is R44's condition. Nothing here is a
 * second, gentler check written for our own transaction to pass.
 *
 * Under `replace` the run also deletes originals, and a delete is the one change a build
 * or a link check can vouch for only if it happened. So the deletes are counted from the
 * manifest, each is checked gone from disk, and a fixture that deleted none is reported
 * as not exercised rather than passed: an intact tree where nothing was removed says
 * nothing about removing.
 */
async function runOptimized(fixture: FixtureSpec, policy: PublicPolicy): Promise<Outcomes> {
  const failures: string[] = [];
  const notExercised: string[] = [];
  const root = await materialise(fixture);

  try {
    const result = await optimizeTree(
      root,
      fixture.publicDirs === undefined ? undefined : { dirs: fixture.publicDirs, declared: true },
      policy,
    );

    if (result.refusal !== null) {
      stdout.write(`  optimize    REFUSED  ${result.refusal.code}\n`);
      failures.push(`${fixture.name}/optimize refused: ${result.refusal.reason}`);
      return { failures, notExercised };
    }

    const deleted = (result.manifest?.operations ?? []).flatMap((operation) =>
      operation.kind === 'delete' ? [operation.path] : [],
    );
    stdout.write(
      `  optimize    ${result.plan.conversions.length} converted, ${result.plan.rewrites.length} rewritten, ${result.plan.declined.length} declined, ${deleted.length} originals deleted\n`,
    );

    // A run that changed nothing cannot demonstrate that changing things is safe, so
    // it is reported rather than passed. A green criterion over an untouched tree is
    // the gate-that-never-ran problem R42 exists about.
    if (result.plan.conversions.length === 0) {
      failures.push(`${fixture.name}: optimize converted nothing, so this proves nothing`);
    }

    // The manifest is a statement of intent written before the work. Only the disk says a
    // delete happened, so it is asked.
    for (const path of deleted) {
      if (existsSync(join(root, path))) {
        failures.push(
          `${fixture.name}: the manifest records ${path} as deleted and it is still on disk`,
        );
      }
    }
    if (policy === 'replace' && deleted.length === 0) {
      stdout.write(
        '  NOT EXERCISED: no original was deleted, so this tree says nothing about deleting\n',
      );
      notExercised.push(fixture.name);
    }

    for (const [instrument, outcome] of await check(root, fixture)) {
      const ok = outcome.verdict === 'intact';
      stdout.write(`  optimized ${instrument.padEnd(11)} ${ok ? 'intact' : 'BROKEN'}\n`);
      if (!ok) failures.push(`${fixture.name}/${instrument}: ${outcome.detail}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  return { failures, notExercised };
}

/** What one optimized fixture came to: what broke, and whether `replace` deleted anything. */
interface Outcomes {
  readonly failures: readonly string[];
  /** Fixtures where `replace` deleted no original, so its deletes were never tested. */
  readonly notExercised: readonly string[];
}

/**
 * The exit criterion over the selected fixtures, under one policy, and the process exit.
 *
 * Three verdicts, not two. A tree that broke fails. A `replace` run where some fixture
 * deleted nothing is not a failure of safety and not a pass either: every tree may be
 * intact precisely because nothing was removed from it.
 */
async function runExitCriterion(
  selected: readonly FixtureSpec[],
  policy: PublicPolicy,
): Promise<never> {
  stdout.write(`\npolicy: ${policy}\n`);
  const failures: string[] = [];
  const notExercised: string[] = [];
  for (const fixture of selected) {
    stdout.write(`\n${fixture.name}\n`);
    failures.push(...(await runBaseline(fixture)));
    const outcomes = await runOptimized(fixture, policy);
    failures.push(...outcomes.failures);
    notExercised.push(...outcomes.notExercised);
  }

  if (failures.length > 0) stdout.write('\nEXIT CRITERION FAILED\n');
  else if (notExercised.length > 0) {
    stdout.write(
      `\nEXIT CRITERION NOT DEMONSTRATED: every tree intact, but no original was deleted in ${notExercised.join(', ')}\n`,
    );
  } else stdout.write('\nEXIT CRITERION MET\n');
  for (const failure of failures) stdout.write(`  ${failure}\n`);
  exit(failures.length === 0 && notExercised.length === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// The same criterion through the built command-line tool
// ---------------------------------------------------------------------------

const CLI_BIN = resolve(FIXTURES_ROOT, '../packages/cli/dist/bin.js');

/** What every copy's repository ignores, as a real project's would. */
const GITIGNORE = `${BUILD_ARTEFACTS.map((name) => `${name}/`).join('\n')}\n`;

/** Git's environment for these runs: no repository above the build folder is consulted. */
const GIT_ENV = { ...process.env, GIT_CEILING_DIRECTORIES: BUILD_ROOT };

/** Runs git with an argument array, never through a shell, and throws on failure. */
function gitIn(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.trim()}`);
  return result.stdout;
}

/**
 * Makes `root` a repository with everything in it committed once, line endings kept as
 * written so a byte comparison after `git revert` means what it says.
 */
function commitEverything(root: string): void {
  gitIn(root, 'init', '--quiet');
  gitIn(root, 'config', 'user.name', 'Upfly fixture build');
  gitIn(root, 'config', 'user.email', 'fixture-build@example.com');
  gitIn(root, 'config', 'commit.gpgsign', 'false');
  gitIn(root, 'config', 'core.autocrlf', 'false');
  gitIn(root, 'add', '-A');
  gitIn(root, 'commit', '--quiet', '-m', 'the fixture, as found');
}

interface CliRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** The last JSON line, for a run given `--json`. */
  readonly result: Record<string, unknown>;
}

/** Runs the built binary as a user runs it. */
function upflyCli(args: readonly string[]): CliRun {
  const run = spawnSync(process.execPath, [CLI_BIN, ...args], { encoding: 'utf8', env: GIT_ENV });
  const last = run.stdout.trimEnd().split('\n').at(-1) ?? '';
  let result: Record<string, unknown> = {};
  if (args.includes('--json') && last.startsWith('{')) result = JSON.parse(last);
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, result };
}

/** Every file in the tree with a hash of its bytes, skipping what the link check skips. */
async function fingerprint(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const file of await walk(root)) {
    files.set(
      file,
      createHash('sha256')
        .update(await readFile(join(root, file)))
        .digest('hex'),
    );
  }
  return files;
}

/** The paths that differ between two fingerprints, to name a failure. */
function differences(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): string[] {
  const paths = new Set([...a.keys(), ...b.keys()]);
  return [...paths].filter((path) => a.get(path) !== b.get(path)).sort();
}

/** The command-line flags that match a fixture's declared folders and a policy. */
function cliFlags(fixture: FixtureSpec, policy: PublicPolicy): string[] {
  const flags = policy === 'replace' ? ['--replace'] : [];
  for (const dir of fixture.publicDirs ?? []) flags.push('--public', dir === '' ? '.' : dir);
  return flags;
}

/** What one applied run wrote, as `--json` reports it. */
interface CliWritten {
  readonly created: string[];
  readonly changed: string[];
  readonly removed: string[];
}

/** One copy of a fixture under test through the command line, and where its failures go. */
interface CliCopy {
  readonly fixture: FixtureSpec;
  readonly policy: PublicPolicy;
  readonly nested: boolean;
  /** The repository's top folder. */
  readonly top: string;
  /** The fixture itself: `top`, or `site/` inside it. */
  readonly project: string;
  readonly flags: readonly string[];
  readonly failures: string[];
  readonly notExercised: string[];
}

function failed(copy: CliCopy, what: string): void {
  copy.failures.push(`${copy.fixture.name}${copy.nested ? ' (nested)' : ''}: ${what}`);
}

/**
 * `upfly optimize --apply --commit` on a copy of one fixture, as a user runs it: a dry run
 * that writes nothing; one commit holding exactly the files the run wrote; a second run
 * with nothing to do and not refused; the build and link check intact; and `git revert`
 * giving back every byte. With `nested`, the fixture is the folder `site/` inside a larger
 * repository whose own staged and untracked work must stay out of the commit.
 */
async function runCliCommit(
  fixture: FixtureSpec,
  policy: PublicPolicy,
  nested: boolean,
): Promise<Outcomes> {
  await mkdir(BUILD_ROOT, { recursive: true });
  const top = await mkdtemp(join(BUILD_ROOT, `${fixture.name}-cli-`));
  const copy: CliCopy = {
    fixture,
    policy,
    nested,
    top,
    project: nested ? join(top, 'site') : top,
    flags: cliFlags(fixture, policy),
    failures: [],
    notExercised: [],
  };

  try {
    await prepareCliCopy(copy);
    const original = await fingerprint(copy.project);
    await cliDryRun(copy, original);
    const commits = Number(gitIn(top, 'rev-list', '--count', 'HEAD'));
    if (await cliApply(copy, commits)) {
      cliSecondRun(copy, commits);
      await cliBuildAndRevert(copy, original);
    }
  } catch (error) {
    failed(copy, error instanceof Error ? error.message : String(error));
  } finally {
    await rm(top, { recursive: true, force: true });
  }
  return { failures: copy.failures, notExercised: copy.notExercised };
}

/** The copy, committed, with work of the user's own outside it when it is nested. */
async function prepareCliCopy(copy: CliCopy): Promise<void> {
  await copyInto(copy.fixture, copy.project);
  await writeFile(join(copy.top, '.gitignore'), GITIGNORE, 'utf8');
  if (copy.nested) {
    await writeFile(join(copy.top, 'notes.txt'), 'the rest of the repository\n', 'utf8');
  }
  commitEverything(copy.top);
  if (copy.nested) {
    await writeFile(join(copy.top, 'notes.txt'), 'staged by hand, outside the project\n', 'utf8');
    gitIn(copy.top, 'add', 'notes.txt');
    await writeFile(join(copy.top, 'draft.md'), 'untracked, outside the project\n', 'utf8');
  }
}

async function cliDryRun(copy: CliCopy, original: ReadonlyMap<string, string>): Promise<void> {
  const dry = upflyCli(['optimize', copy.project, ...copy.flags]);
  const changed = differences(original, await fingerprint(copy.project));
  if (dry.status !== 0) failed(copy, `the dry run exited ${dry.status}: ${dry.stderr.trim()}`);
  if (changed.length > 0) failed(copy, `the dry run wrote ${changed.join(', ')}`);
  if (copy.nested && !dry.stdout.includes(`in the git repository at ${copy.top}`)) {
    failed(copy, 'the dry run did not name the repository around the project');
  }
  stdout.write(`  cli dry run     exit ${dry.status}, ${changed.length} files changed\n`);
}

/** The applied, committed run. False when it wrote nothing, so there is nothing to check. */
async function cliApply(copy: CliCopy, commits: number): Promise<boolean> {
  const applied = upflyCli([
    'optimize',
    copy.project,
    '--apply',
    '--commit',
    '--json',
    ...copy.flags,
  ]);
  const written = applied.result.run as CliWritten | null | undefined;
  if (applied.status !== 0 || written === null || written === undefined) {
    failed(copy, `--apply --commit exited ${applied.status}: ${applied.stderr.trim()}`);
    return false;
  }
  if (written.created.length === 0) {
    failed(copy, '--apply converted nothing, so this proves nothing');
    return false;
  }

  const inRepo = (path: string) => (copy.nested ? `site/${path}` : path);
  const expected = [...written.created, ...written.changed, ...written.removed].map(inRepo).sort();
  const committed = gitIn(copy.top, 'show', '--name-only', '--format=', 'HEAD')
    .trim()
    .split('\n')
    .sort();
  if (Number(gitIn(copy.top, 'rev-list', '--count', 'HEAD')) !== commits + 1) {
    failed(copy, '--commit did not make exactly one commit');
  }
  if (JSON.stringify(committed) !== JSON.stringify(expected)) {
    failed(copy, `the commit holds ${committed.join(', ')}; the run wrote ${expected.join(', ')}`);
  }
  if (copy.nested && gitIn(copy.top, 'diff', '--cached', '--name-only').trim() !== 'notes.txt') {
    failed(copy, 'the work staged outside the project did not stay staged and out of the commit');
  }
  if (copy.policy === 'replace' && written.removed.length === 0) {
    stdout.write(
      '  NOT EXERCISED: no original was deleted, so this tree says nothing about deleting\n',
    );
    copy.notExercised.push(`${copy.fixture.name}${copy.nested ? ' (nested)' : ''}`);
  }
  stdout.write(
    `  cli apply       ${written.created.length} converted, ${written.changed.length} rewritten, ${written.removed.length} originals deleted, one commit of ${committed.length} files\n`,
  );
  return true;
}

function cliSecondRun(copy: CliCopy, commits: number): void {
  const second = upflyCli(['optimize', copy.project, '--apply', '--json', ...copy.flags]);
  const wrote = second.result.run !== null;
  if (second.status !== 0) {
    failed(copy, `the second run exited ${second.status}: ${second.stderr.trim()}`);
  } else if (wrote) {
    failed(copy, 'the second run wrote files');
  }
  if (Number(gitIn(copy.top, 'rev-list', '--count', 'HEAD')) !== commits + 1) {
    failed(copy, 'the second run made a commit');
  }
  stdout.write(
    `  cli second run  exit ${second.status}, ${wrote ? 'WROTE FILES' : 'nothing to do'}\n`,
  );
}

async function cliBuildAndRevert(
  copy: CliCopy,
  original: ReadonlyMap<string, string>,
): Promise<void> {
  const beforeBuild = await fingerprint(copy.project);
  for (const [instrument, outcome] of await check(copy.project, copy.fixture)) {
    const ok = outcome.verdict === 'intact';
    stdout.write(`  cli ${instrument.padEnd(11)} ${ok ? 'intact' : 'BROKEN'}\n`);
    if (!ok) failed(copy, `${instrument}: ${outcome.detail}`);
  }
  // A build can leave files of its own, such as a generated TypeScript declaration.
  const afterBuild = await fingerprint(copy.project);
  const generated = [...afterBuild.keys()].filter((path) => !beforeBuild.has(path));

  // Git will not revert while other work is staged, so a nested copy's user commits theirs
  // first, and Upfly's commit is then reverted by its hash, no longer the newest.
  const upflyCommit = gitIn(copy.top, 'rev-parse', 'HEAD').trim();
  if (copy.nested) gitIn(copy.top, 'commit', '--quiet', '-m', 'the user commits their own work');
  gitIn(copy.top, 'revert', '--no-edit', upflyCommit);
  const reverted = await fingerprint(copy.project);
  for (const path of generated) reverted.delete(path);
  const left = differences(original, reverted);
  if (left.length > 0) failed(copy, `git revert left ${left.join(', ')} different`);
  stdout.write(
    `  cli git revert  ${left.length === 0 ? 'every byte back' : `${left.length} files DIFFERENT`}\n`,
  );
}

/** `upfly optimize --apply` and then `upfly undo` on a copy of one fixture: every byte back. */
async function runCliUndo(fixture: FixtureSpec, policy: PublicPolicy): Promise<string[]> {
  const failures: string[] = [];
  await mkdir(BUILD_ROOT, { recursive: true });
  const top = await mkdtemp(join(BUILD_ROOT, `${fixture.name}-undo-`));
  try {
    await copyInto(fixture, top);
    await writeFile(join(top, '.gitignore'), GITIGNORE, 'utf8');
    commitEverything(top);
    const original = await fingerprint(top);
    const flags = cliFlags(fixture, policy);

    const applied = upflyCli(['optimize', top, '--apply', '--json', ...flags]);
    const written = applied.result.run as CliWritten | null;
    if (applied.status !== 0 || written === null) {
      failures.push(`${fixture.name}: --apply exited ${applied.status} and wrote nothing`);
      return failures;
    }
    const undo = upflyCli(['undo', top, '--json']);
    const left = differences(original, await fingerprint(top));
    if (undo.status !== 0)
      failures.push(`${fixture.name}: undo exited ${undo.status}: ${undo.stderr.trim()}`);
    if (left.length > 0) failures.push(`${fixture.name}: undo left ${left.join(', ')} different`);
    stdout.write(
      `  cli undo        ${written.created.length + written.changed.length + written.removed.length} files written, ${left.length === 0 ? 'every byte back' : `${left.length} files DIFFERENT`}\n`,
    );
  } catch (error) {
    failures.push(`${fixture.name}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await rm(top, { recursive: true, force: true });
  }
  return failures;
}

/**
 * The criterion through the built binary, for each fixture: in a repository of its own, as
 * a folder inside a larger one, and undone with `upfly undo`.
 */
async function runCliCriterion(
  selected: readonly FixtureSpec[],
  policy: PublicPolicy,
): Promise<never> {
  if (!existsSync(CLI_BIN)) {
    stdout.write(`${CLI_BIN} is missing; run pnpm build first.\n`);
    exit(2);
  }
  stdout.write(`\nthrough the built CLI, policy: ${policy}\n`);
  const failures: string[] = [];
  const notExercised: string[] = [];
  for (const fixture of selected) {
    for (const nested of [false, true]) {
      stdout.write(`\n${fixture.name}${nested ? ', inside a larger repository' : ''}\n`);
      const outcomes = await runCliCommit(fixture, policy, nested);
      failures.push(...outcomes.failures);
      notExercised.push(...outcomes.notExercised);
    }
    failures.push(...(await runCliUndo(fixture, policy)));
  }

  if (failures.length > 0) stdout.write('\nCLI CRITERION FAILED\n');
  else if (notExercised.length > 0) {
    stdout.write(
      `\nCLI CRITERION NOT DEMONSTRATED: every tree intact, but no original was deleted in ${notExercised.join(', ')}\n`,
    );
  } else stdout.write('\nCLI CRITERION MET\n');
  for (const failure of failures) stdout.write(`  ${failure}\n`);
  exit(failures.length === 0 && notExercised.length === 0 ? 0 : 1);
}

async function main(): Promise<void> {
  const only = argv.find((argument) => argument.startsWith('--fixture='))?.split('=')[1];
  // `--public=<dir>`, repeatable, declares the serving roots the way a user would after
  // reading the report's sentence, with "." for the project root. It replaces the
  // fixture's own declaration, so a run with it tests the user's fix, not the fixture.
  const declared = argv
    .filter((argument) => argument.startsWith('--public='))
    .map((argument) => argument.slice('--public='.length).replace(/^\.\/?$/, ''));
  const selected = (only ? FIXTURES.filter((f) => f.name === only) : FIXTURES).map((fixture) =>
    declared.length === 0 ? fixture : { ...fixture, publicDirs: declared },
  );

  if (selected.length === 0) {
    stdout.write(`No fixture named ${only}.\n`);
    exit(2);
  }

  const rows: Row[] = [];
  const baselineFailures: string[] = [];

  // The exit criterion on its own. The calibration below it, the baseline plus every
  // negative control, is what makes the criterion mean anything, but it is slow and
  // does not change between runs, so iterating on the criterion need not repeat it.
  // `--replace` runs it under the policy that deletes originals.
  if (argv.includes('--optimize')) {
    await runExitCriterion(selected, argv.includes('--replace') ? 'replace' : 'keep-original');
  }
  // `--cli` runs the same criterion through the built binary, with git.
  if (argv.includes('--cli')) {
    await runCliCriterion(selected, argv.includes('--replace') ? 'replace' : 'keep-original');
  }

  for (const fixture of selected) {
    stdout.write(`\n${fixture.name}\n`);
    baselineFailures.push(...(await runBaseline(fixture)));
    for (const mutation of fixture.mutations) {
      rows.push(...(await runMutation(fixture, mutation)));
    }
  }

  await writeReport(rows, baselineFailures);

  if (baselineFailures.length > 0) {
    stdout.write('\nBASELINE FAILED — the harness cannot vouch for anything:\n');
    for (const failure of baselineFailures) stdout.write(`  ${failure}\n`);
    exit(1);
  }

  // Every class must be seen by at least one instrument, or the exit criterion has
  // a hole in exactly the shape of that class and nobody would be told.
  const unseen = coverageHoles(rows);
  stdout.write(
    `\n${rows.length} (class, instrument) results across ${selected.length} fixtures.\n`,
  );

  if (unseen.length > 0) {
    stdout.write(`\n⚠️  ${unseen.length} (fixture, class) pairs no instrument can see:\n`);
    for (const hole of unseen) stdout.write(`  ${hole}\n`);
  }
}

/** `(fixture, class)` pairs where every instrument reported the broken tree intact. */
function coverageHoles(rows: readonly Row[]): string[] {
  const byPair = new Map<string, boolean>();
  for (const row of rows) {
    const key = `${row.fixture} / ${row.referenceClass}`;
    byPair.set(key, (byPair.get(key) ?? false) || row.sighted);
  }
  return [...byPair.entries()].filter(([, seen]) => !seen).map(([key]) => key);
}

async function writeReport(
  rows: readonly Row[],
  baselineFailures: readonly string[],
): Promise<void> {
  const lines: string[] = [
    '# Fixture build harness — what each instrument can actually see',
    '',
    'Generated by `bench/src/fixture-build.ts`. Each row is one deliberately broken',
    'reference. **sighted** means the instrument reported the tree broken; **BLIND**',
    'means it reported the tree intact while a reference pointed at nothing.',
    '',
    '| fixture | reference class | instrument | verdict |',
    '|---|---|---|---|',
  ];

  for (const row of rows) {
    lines.push(
      `| ${row.fixture} | ${row.referenceClass} | ${row.instrument} | ${row.sighted ? 'sighted' : '**BLIND**'} |`,
    );
  }

  const holes = coverageHoles(rows);
  lines.push('', '## Pairs no instrument can see', '');
  lines.push(holes.length === 0 ? 'None.' : holes.map((hole) => `- ${hole}`).join('\n'));

  if (baselineFailures.length > 0) {
    lines.push('', '## Baseline failures', '', ...baselineFailures.map((f) => `- ${f}`));
  }

  const out = resolve(FIXTURES_ROOT, '../../notes/validation/fixture-build.md');
  await writeFile(out, `${lines.join('\n')}\n`, 'utf8');
  stdout.write(`\nWrote ${relative(process.cwd(), out)}\n`);
}

/** Every file in the tree, POSIX-relative, skipping dependency and output directories. */
async function walk(root: string, prefix = ''): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (NEVER_COPY.has(entry.name)) continue;
    const child = prefix === '' ? entry.name : posix.join(prefix, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(root, child)));
    else if (entry.isFile()) found.push(child);
  }
  return found.sort();
}

function tail(text: string, lines: number): string {
  return text.trimEnd().split('\n').slice(-lines).join('\n');
}

await main();
