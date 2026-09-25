/**
 * R71-b: can a serving root be INFERRED by resolution rate, and is there daylight?
 *
 * 🔴 **The number this exists to produce is the GAP** — what the hand-verified root
 * scores against what the best WRONG candidate scores, **on the same references**. Not
 * the winner's score. A winner at 100% means nothing if a wrong directory also reaches
 * 100%, and the gap is what an acceptance bar would have to sit inside, exactly the way
 * R51's 25% floor was set by finding daylight between two measured populations.
 *
 * ⚠️ **If there is no daylight, R71 does not ship, and that is an expected outcome, not
 * a failure of this instrument.** Two of R71's three levers have already died under
 * examination. This one is allowed to die too, in writing, with its number.
 *
 * **What the walk is.** The resolver already climbs a file's ancestors looking for a
 * directory *named* `public` or `static`. This is that same walk **with the name filter
 * removed and a resolution test put in its place** (R71-b's constraint): at every
 * ancestor `A` of a directory, both `A` itself and each of `A`'s child directories is a
 * candidate serving root. `A` itself is what makes `railsgirls-com`'s `''` reachable;
 * the child rung is what makes `shadcn-ui`'s `templates/next-app/public` reachable from
 * a file in `templates/next-app/src/`, which an ancestors-only walk never reaches.
 *
 * 🔴 **EVERY CANDIDATE IS SCORED ON ONE DIRECTORY'S REFERENCES AT A TIME, AND THIS IS
 * THE CORRECTION THAT MATTERS.** The first version of this file scored each candidate
 * across the whole repository, so `<project root>` was measured over all 769 of
 * `shadcn-ui`'s references while `templates/next-app/public` was measured over the
 * handful beneath it. Two rates over different denominators are not comparable, and
 * subtracting them is not a gap. Per directory, every candidate answers the same
 * question about the same references, and the subtraction means something.
 *
 * ⚠️ **Candidates are tested against the IN-MEMORY asset set, never the disk** — R71-b's
 * other constraint. `existsSync` per candidate per reference is tens of millions of
 * syscalls and would make a cheap experiment expensive.
 *
 * ⚠️ **Ancestors only, and never a sibling.** Resolving against a sibling app's public
 * directory is what produced 93 false `broken` findings in `shadcn-ui`, and the
 * restraint that fixed it is preserved here rather than re-litigated.
 *
 * ✅ **The control is real**, which is the only reason the experiment is worth running:
 * five repositories carry hand-verified serving roots in `repos.ts`, including
 * `eleventy-docs`' `src/`, which no name-matching rule can find, and `shadcn-ui`'s
 * twelve.
 *
 * Read-only. Never writes inside the corpus (R52).
 *
 * Usage:
 *   pnpm --filter upfly-bench run root-inference
 *   pnpm --filter upfly-bench run root-inference -- --repo=eleventy-docs --verbose
 */

import { readFile } from 'node:fs/promises';
import { argv, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';
// 🔴 ONE copy of the denominator. This instrument's first version counted every
// root-relative reference, not only the ones that could name an asset, and made
// astro-docs' `public` score 0.1% — the ranking stayed right and the rates were nonsense.
// The filter it grew afterwards is now shared with the wiring in `serving-root-decision.ts`,
// because a second implementation of a denominator is how the two silently disagree.
import {
  type Adapter,
  type RawReference,
  defaultAdapters,
  discover,
  isRootRelative,
  looksLikeAsset,
  scanSources,
} from 'upfly-core';
import { REPOS, VALIDATION_ROOT } from './repos.js';

const ADAPTERS: readonly Adapter[] = defaultAdapters;

/**
 * A directory needs this many root-relative asset references before its gap counts.
 *
 * 🔴 **This is the `docs-examples/public` lesson as a constant.** The coverage tree
 * holds a directory named `public` that serves nothing: a genuine root resolves many
 * references against it, that one resolves exactly ONE — and one-for-one is 100%. A rate
 * computed over a single reference is not a rate, and an acceptance bar reading only the
 * percentage would take that directory for a serving root.
 *
 * ⚠️ **Both populations are reported**, thin directories included and excluded, because
 * the floor is a choice and burying it in the result would make the gap look like a
 * property of the data rather than partly a property of this number.
 */
const MIN_REFERENCES = Number(
  argv.find((a) => a.startsWith('--min='))?.slice('--min='.length) ?? 5,
);

interface Scored {
  readonly dir: string;
  readonly hits: number;
  readonly rate: number;
}

/** One source directory's verdict: can its true root be told from every wrong one? */
export interface DirectoryVerdict {
  readonly dir: string;
  readonly references: number;
  readonly candidates: number;
  readonly bestTruth: Scored | undefined;
  readonly bestWrong: Scored | undefined;
  /** `bestTruth.rate - bestWrong.rate`, in points. Negative means a wrong root wins. */
  readonly gap: number;
  /** Did the highest-scoring candidate turn out to be a hand-verified root? */
  readonly argmaxCorrect: boolean;
  /** No hand-verified root is even reachable from here. */
  readonly truthUnreachable: boolean;
}

export interface RepoResult {
  readonly repo: string;
  readonly truth: readonly string[];
  readonly references: number;
  readonly directories: readonly DirectoryVerdict[];
  readonly unscanned: number;
}

/** POSIX-relative directory of a POSIX-relative file path. `''` for the root. */
function dirOf(relative: string): string {
  const cut = relative.lastIndexOf('/');
  return cut === -1 ? '' : relative.slice(0, cut);
}

/** Every ancestor-or-self directory, nearest first, ending at `''`. */
function ancestors(dir: string): string[] {
  const out: string[] = [];
  let current = dir;
  for (;;) {
    out.push(current);
    if (current === '') break;
    current = dirOf(current);
  }
  return out;
}

/** The path a candidate root would serve this reference from. */
function underRoot(dir: string, raw: string): string {
  const tail = raw.slice(1);
  return dir === '' ? tail : `${dir}/${tail}`;
}

async function measureRepo(
  name: string,
  truth: readonly string[],
  verbose: boolean,
): Promise<RepoResult> {
  return measureRepoAt(`${VALIDATION_ROOT}/${name}`, name, truth, verbose);
}

export async function measureRepoAt(
  root: string,
  name: string,
  truth: readonly string[],
  verbose: boolean,
): Promise<RepoResult> {
  const found = await discover({ root, adapters: ADAPTERS });
  const assets = new Set(found.assets.map((asset) => asset.relative));

  // Every directory holding at least one asset, at any depth. A candidate holding no
  // asset cannot resolve anything, so including it would pad the candidate count
  // without ever competing for the gap.
  const assetDirs = new Set<string>();
  for (const asset of found.assets) {
    for (const dir of ancestors(dirOf(asset.relative))) assetDirs.add(dir);
  }

  const scanned = await scanSources({
    sourceFiles: found.sourceFiles,
    adapters: ADAPTERS,
    readFile: (path: string) => readFile(path, 'utf8'),
  });

  const byDir = new Map<string, RawReference[]>();
  let references = 0;
  for (const reference of scanned.references) {
    if (!isRootRelative(reference.rawPath)) continue;
    if (!looksLikeAsset(reference.rawPath)) continue;
    const relative = reference.file
      .slice(root.length + 1)
      .split('\\')
      .join('/');
    const dir = dirOf(relative);
    const bucket = byDir.get(dir);
    if (bucket === undefined) byDir.set(dir, [reference]);
    else bucket.push(reference);
    references++;
  }

  const truthSet = new Set(truth);
  const verdicts: DirectoryVerdict[] = [];

  for (const [dir, refs] of byDir) {
    const candidates = new Set<string>();
    for (const ancestor of ancestors(dir)) {
      if (assetDirs.has(ancestor)) candidates.add(ancestor);
      const prefix = ancestor === '' ? '' : `${ancestor}/`;
      for (const assetDir of assetDirs) {
        if (!assetDir.startsWith(prefix)) continue;
        const rest = assetDir.slice(prefix.length);
        if (rest !== '' && !rest.includes('/')) candidates.add(assetDir);
      }
    }

    const scored: Scored[] = [];
    for (const candidate of candidates) {
      let hits = 0;
      for (const reference of refs) {
        if (assets.has(underRoot(candidate, reference.rawPath))) hits++;
      }
      scored.push({ dir: candidate, hits, rate: hits / refs.length });
    }
    scored.sort((a, b) => b.rate - a.rate || a.dir.length - b.dir.length);

    const bestTruth = scored.find((s) => truthSet.has(s.dir));
    const bestWrong = scored.find((s) => !truthSet.has(s.dir));
    const top = scored[0];

    verdicts.push({
      dir,
      references: refs.length,
      candidates: scored.length,
      bestTruth,
      bestWrong,
      gap: (bestTruth?.rate ?? 0) - (bestWrong?.rate ?? 0),
      argmaxCorrect: top !== undefined && truthSet.has(top.dir),
      truthUnreachable: bestTruth === undefined,
    });

    if (verbose && refs.length >= MIN_REFERENCES) {
      stdout.write(`\n    ${dir || '<project root>'}  (${refs.length} refs)\n`);
      for (const s of scored.slice(0, 6)) {
        stdout.write(
          `      ${truthSet.has(s.dir) ? '✅' : '  '} ${(s.dir || '<project root>').padEnd(58)} ${(s.rate * 100).toFixed(1).padStart(6)}%  ${s.hits}/${refs.length}\n`,
        );
      }
    }
  }

  return {
    repo: name,
    truth,
    references,
    directories: verdicts,
    unscanned: scanned.unscanned.length,
  };
}

function summarise(verdicts: readonly DirectoryVerdict[], label: string): string {
  if (verdicts.length === 0) return `  ${label}: no directories\n`;

  const refs = verdicts.reduce((sum, v) => sum + v.references, 0);
  const weighted = verdicts.reduce((sum, v) => sum + v.gap * v.references, 0) / Math.max(1, refs);
  const gaps = verdicts.map((v) => v.gap).sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)] ?? 0;
  const noDaylight = verdicts.filter((v) => v.gap <= 0);
  const noDaylightRefs = noDaylight.reduce((sum, v) => sum + v.references, 0);
  const argmax = verdicts.filter((v) => v.argmaxCorrect).length;
  const unreachable = verdicts.filter((v) => v.truthUnreachable);

  // 🔴 THE TWO POPULATIONS, which is how R51's 25% floor was set: not by choosing a
  // number that felt safe, but by scoring the things that should pass and the things
  // that should fail and looking for air between them. A bar is only defensible if
  // these two distributions do not overlap.
  const truthRates = verdicts
    .filter((v) => v.bestTruth !== undefined)
    .map((v) => v.bestTruth?.rate ?? 0)
    .sort((a, b) => a - b);
  const wrongRates = verdicts
    .filter((v) => v.bestWrong !== undefined)
    .map((v) => v.bestWrong?.rate ?? 0)
    .sort((a, b) => a - b);
  const at = (list: readonly number[], q: number) => list[Math.floor(list.length * q)] ?? 0;

  const pct = (n: number) => `${(n * 100).toFixed(1)}`;
  return [
    `  ${label}`,
    `    directories / references        : ${verdicts.length} / ${refs}`,
    `    🔴 GAP, reference-weighted      : ${weighted >= 0 ? '+' : ''}${pct(weighted)} points`,
    `    🔴 GAP, median directory        : ${median >= 0 ? '+' : ''}${pct(median)} points`,
    `    worst / best directory gap      : ${pct(gaps[0] ?? 0)} / ${pct(gaps[gaps.length - 1] ?? 0)}`,
    `    directories with NO daylight    : ${noDaylight.length} (${noDaylightRefs} refs)`,
    // 🔴 The two ways a gap can be zero are NOT the same finding, and collapsing them
    // would hide the one that matters. "Nothing resolves anywhere" is a directory with
    // no signal — the inference has nothing to go on and declines, which is correct.
    // "A tie above zero" is a directory where a WRONG root resolves exactly as much as
    // the right one: real ambiguity, and the only case where an acceptance bar could
    // silently choose wrong.
    `      ...of those, tie above zero  : ${noDaylight.filter((v) => (v.bestTruth?.rate ?? 0) > 0).length}`,
    `      ...of those, nothing resolves: ${noDaylight.filter((v) => (v.bestTruth?.rate ?? 0) === 0 && (v.bestWrong?.rate ?? 0) === 0).length}`,
    `    directories where a WRONG root WINS: ${verdicts.filter((v) => v.gap < 0).length}`,
    `    top-ranked candidate is correct : ${argmax}/${verdicts.length} (${pct(argmax / verdicts.length)}%)`,
    `    true root not even reachable    : ${unreachable.length}`,
    `    TRUE roots   min / p25 / med   : ${pct(truthRates[0] ?? 0)} / ${pct(at(truthRates, 0.25))} / ${pct(at(truthRates, 0.5))}`,
    `    WRONG roots  med / p75 / max   : ${pct(at(wrongRates, 0.5))} / ${pct(at(wrongRates, 0.75))} / ${pct(wrongRates[wrongRates.length - 1] ?? 0)}`,
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const only = argv.find((a) => a.startsWith('--repo='))?.slice('--repo='.length);
  const verbose = argv.includes('--verbose');

  // The configured entries carry the hand-verified answer. The `unconfigured` twins are
  // the same repositories with the configuration removed, so their `publicDirs` is not a
  // truth claim and scoring against it would be scoring against a blank.
  const subjects = REPOS.filter(
    (repo) => repo.unconfigured !== true && (only === undefined || repo.name === only),
  );

  // 🔴 `--tree=` and `--truth=` exist for ONE reason: to point this instrument at a
  // corpus where the answer should be NO. An instrument that has only ever been run on
  // inputs it gets right has not been shown to be able to get anything wrong (R117),
  // and the run below reports `worst directory gap: 0.0` across all five repositories —
  // never once a wrong root winning. That is either a property of the corpus or a
  // property of this file, and only a refuting input can tell the two apart.
  const tree = argv.find((a) => a.startsWith('--tree='))?.slice('--tree='.length);
  if (tree !== undefined) {
    const declared = (argv.find((a) => a.startsWith('--truth='))?.slice('--truth='.length) ?? '')
      .split(',')
      .filter((entry) => entry !== '')
      .map((entry) => (entry === '<root>' ? '' : entry));
    stdout.write(`
${'='.repeat(74)}
AD-HOC TREE: ${tree}
`);
    stdout.write(`  declared truth: ${declared.map((d) => d || '<project root>').join(', ')}

`);
    const result = await measureRepoAt(tree, tree, declared, verbose);
    stdout.write(
      `  root-relative ASSET references: ${result.references}   unscanned (R86): ${result.unscanned}

`,
    );
    stdout.write(
      summarise(
        result.directories.filter((v) => v.references >= MIN_REFERENCES),
        `directories with >= ${MIN_REFERENCES} references`,
      ),
    );
    stdout.write(summarise(result.directories, 'every directory, thin ones included'));
    return;
  }

  stdout.write('\nR71-b — inferring a serving root by resolution rate\n\n');
  stdout.write("  the walk : every ancestor of a directory, plus each ancestor's children\n");
  stdout.write('  tested   : against the in-memory asset set, never the disk\n');
  stdout.write('  scored   : one source directory at a time, so every candidate answers\n');
  stdout.write('             the same question about the same references\n');

  const all: DirectoryVerdict[] = [];
  for (const repo of subjects) {
    const result = await measureRepo(repo.name, repo.publicDirs, verbose);
    all.push(...result.directories);

    const thick = result.directories.filter((v) => v.references >= MIN_REFERENCES);
    stdout.write(`\n${'='.repeat(74)}\n${result.repo}\n`);
    stdout.write(
      `  truth: ${result.truth.map((d) => d || '<project root>').join(', ') || '(none)'}\n`,
    );
    stdout.write(
      `  root-relative ASSET references: ${result.references}   unscanned (R86): ${result.unscanned}\n\n`,
    );
    stdout.write(summarise(thick, `directories with >= ${MIN_REFERENCES} references`));
    stdout.write(summarise(result.directories, 'every directory, thin ones included'));
  }

  if (only === undefined) {
    stdout.write(`${'='.repeat(74)}\nALL FIVE REPOSITORIES — the number R71 turns on\n\n`);
    stdout.write(
      summarise(
        all.filter((v) => v.references >= MIN_REFERENCES),
        `>= ${MIN_REFERENCES} references`,
      ),
    );
    stdout.write(summarise(all, 'every directory'));
  }
}

/**
 * Run only when invoked as the entry point, so a test can import the measurement.
 *
 * ⚠️ **`bench/`'s convention is that entry points carry a top-level `main()` and are not
 * importable** — `samples.ts` says so, and a test that imported one would run it. This is
 * the standard ESM main-module check rather than an exception to that rule: under vitest
 * `process.argv[1]` is the test runner, so `main()` does not fire and the file behaves as
 * a library. **The reason it matters here is R117.** This instrument's ability to return
 * *no* was demonstrated by a command somebody has to remember to run; an assertion that
 * runs on every `pnpm check` is the version that survives.
 */
if (import.meta.url === pathToFileURL(argv[1] ?? '').href) await main();
