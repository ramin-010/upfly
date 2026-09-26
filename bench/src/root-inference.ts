/**
 * Whether a serving root can be inferred from how many references it resolves. For each
 * source directory it scores every candidate on that directory's references, and reports the
 * gap between the best root `repos.ts` lists and the best wrong one. An acceptance bar has to
 * sit inside that gap: a winner at 100% means nothing if a wrong root does as well.
 *
 * Candidates are where the resolver would look, at any name: at each ancestor of the
 * directory, the ancestor and its child directories, never a sibling. They are checked
 * against the in-memory asset set, not the disk, which would cost a lookup per candidate per
 * reference. See "Inference: what the references resolve against" in ARCHITECTURE.md.
 *
 * Read-only. Usage: `pnpm --filter upfly-bench run root-inference [-- --repo=<name> --verbose]`
 */

import { readFile } from 'node:fs/promises';
import { argv, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';
// `isRootRelative` and `looksLikeAsset` are the engine's own filters, so this scores the same
// references `decideServingRoots` does.
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
 * How many root-relative asset references a directory needs before its gap counts, set with
 * `--min=`. A rate over a handful is not a measurement: the coverage tree's
 * `docs-examples/public` serves nothing, yet resolves both of its own references, and a bar
 * reading the rate alone would take it for a serving root.
 *
 * Both populations are reported, thin directories included and excluded, because the floor
 * is a choice, and the gap should not look like a property of the data alone.
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
  /** `bestTruth.rate - bestWrong.rate`, from -1 to 1. Negative means a wrong root wins. */
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

  // Every directory with an asset somewhere beneath it. Any other candidate resolves
  // nothing, so it would pad the candidate count without ever competing for the gap.
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

  // True and wrong roots' rates as two populations. A bar is defensible only where the two
  // do not overlap, which is also how `RESOLUTION_FLOOR` was chosen.
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
    // No daylight has two causes that must stay apart. When nothing resolves, inference has
    // nothing to go on and declines, which is correct. When a wrong root resolves at least
    // as much as a true root that resolves something, the ambiguity is real, and that is
    // where a bar could choose wrong without anyone seeing.
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

  // `--tree=` and `--truth=` measure any directory against a stated answer, so the
  // instrument can be shown an input where a wrong root should win. On the five
  // repositories none ever does, and only such an input tells whether that is the corpus
  // or this file. `root-inference.test.ts` does the same on every test run.
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
 * Runs only as the entry point, so `root-inference.test.ts` can import the measurement.
 * Other `bench/` entry points run `main()` on import. Under vitest `process.argv[1]` is the
 * test runner, so this standard ESM check keeps `main()` from firing.
 */
if (import.meta.url === pathToFileURL(argv[1] ?? '').href) await main();
