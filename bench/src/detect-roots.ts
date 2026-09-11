/**
 * Does serving-root detection agree with the lists somebody tuned by hand?
 *
 * Every entry in the validation corpus carries hand-written `publicDirs`, which is a
 * claim that the tuned value is what a user has. Nobody had checked it: the engine's
 * zero-false-`broken` figure was measured five times against configuration no first
 * run produces. This is the control for that, and it reads the same `REPOS` table
 * the harness runs, so the two cannot drift apart.
 *
 * Reports differences rather than asserting agreement. A difference is the finding.
 *
 * `--delta` goes further and resolves every reference twice, once under each set of
 * roots, because agreeing on a list of directories is a weaker claim than resolving
 * references the same way. It is the half of the experiment that says whether a
 * disagreement costs anything.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { argv, stdout } from 'node:process';
import {
  type Adapter,
  type Asset,
  type Reference,
  type ServingRoots,
  defaultAdapters,
  detectServingRoots,
  discover,
  loadAliases,
  resolveReferences,
  scanSources,
} from 'upfly-core';
import { REPOS, type RepoSpec, VALIDATION_ROOT } from './repos.js';

const ADAPTERS: readonly Adapter[] = defaultAdapters;

interface Comparison {
  readonly repo: string;
  readonly handTuned: readonly string[];
  readonly detected: readonly string[];
  readonly missed: readonly string[];
  readonly extra: readonly string[];
  readonly directoriesWalked: number;
}

/**
 * `['']` and `[]` both mean "the project root serves the URL space".
 *
 * The configured entry says so by naming the root; detection says so by finding no
 * conventional directory and leaving the resolver to its project-root rung. Treating
 * them as a difference would report a disagreement that does not exist, and R48
 * measured identical findings either way.
 */
function normalise(dirs: readonly string[]): readonly string[] {
  return dirs.filter((dir) => dir !== '');
}

function basenamesOf(assets: readonly Asset[]): Set<string> {
  return new Set(assets.map((asset) => asset.relative.split('/').pop()?.toLowerCase() ?? ''));
}

async function compare(repo: RepoSpec, names: readonly string[] | undefined): Promise<Comparison> {
  const root = join(VALIDATION_ROOT, repo.name);
  const discovery = await discover({ root, adapters: ADAPTERS });
  const detected = detectServingRoots(discovery.directories, names).dirs;
  const handTuned = normalise(repo.publicDirs);

  return {
    repo: repo.name,
    handTuned,
    detected,
    missed: handTuned.filter((dir) => !detected.includes(dir)),
    extra: detected.filter((dir) => !handTuned.includes(dir)),
    directoriesWalked: discovery.directories.length,
  };
}

/** Every reference resolved twice, once per set of serving roots. */
async function delta(repo: RepoSpec, names: readonly string[] | undefined): Promise<string[]> {
  const root = join(VALIDATION_ROOT, repo.name);
  const readFileText = (path: string) => readFile(path, 'utf8');

  const discovery = await discover({ root, adapters: ADAPTERS });
  const scanned = await scanSources({
    sourceFiles: discovery.sourceFiles,
    adapters: ADAPTERS,
    readFile: readFileText,
    assetBasenames: basenamesOf(discovery.assets),
  });
  const aliases = await loadAliases({
    root: discovery.root,
    files: [...discovery.sourceFiles, ...discovery.unscannedFiles],
    readFile: readFileText,
    exists: (path) => existsSync(path),
  });

  const resolveWith = (servingRoots: ServingRoots): readonly Reference[] =>
    resolveReferences(scanned.references, {
      root: discovery.root,
      assets: discovery.assets,
      servingRoots,
      excludedRoots: discovery.excludedRoots,
      aliases,
      exists: (path) => existsSync(path),
    });

  const configured = resolveWith({ dirs: repo.publicDirs, declared: true });
  const auto = resolveWith(detectServingRoots(discovery.directories, names));

  // Both counts, because they are different numbers and only one of them is the
  // denominator of this table: the resolver returns a reference per path it was
  // asked about, and the scan raises many more strings than it ends up asking about.
  return [
    `${repo.name}: ${scanned.references.length} scanned, ${configured.length} resolved against`,
    ...table(configured, auto),
    ...changed(configured, auto),
  ];
}

function countByResolution(references: readonly Reference[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const reference of references) {
    counts.set(reference.resolution, (counts.get(reference.resolution) ?? 0) + 1);
  }
  return counts;
}

function table(configured: readonly Reference[], auto: readonly Reference[]): string[] {
  const left = countByResolution(configured);
  const right = countByResolution(auto);
  const kinds = [...new Set([...left.keys(), ...right.keys()])].sort();

  const lines = ['  resolution            configured   detected   delta'];
  for (const kind of kinds) {
    const before = left.get(kind) ?? 0;
    const after = right.get(kind) ?? 0;
    const change = after - before;
    lines.push(
      [
        `  ${kind}`.padEnd(24),
        String(before).padStart(10),
        String(after).padStart(11),
        (change > 0 ? `+${change}` : String(change)).padStart(8),
      ].join(''),
    );
  }
  return lines;
}

/** The file a reference landed on, or null when it did not land on one. */
function pathOf(reference: Reference): string | null {
  return reference.resolution === 'resolved' ? reference.resolvedPath : null;
}

/**
 * The references the two configurations disagree about, named rather than counted.
 *
 * A bucket delta says how many moved; this says which, and whether the path the
 * detected run now calls broken is a file that is actually there. A false `broken`
 * is the cheap failure and a false link is the expensive one, so the two have to be
 * told apart by looking, not by totalling.
 */
function changed(configured: readonly Reference[], auto: readonly Reference[]): string[] {
  const after = new Map(auto.map((reference, index) => [index, reference]));
  const lines: string[] = [];

  for (const [index, before] of configured.entries()) {
    const now = after.get(index);
    if (now === undefined) continue;

    // Same bucket, different file. Counts alone cannot see this, and it is the
    // expensive direction: a reference that still resolves but resolves somewhere
    // else is a false link, and in this phase a false link rewrites a file.
    if (now.resolution === before.resolution) {
      const wasPath = pathOf(before);
      const nowPath = pathOf(now);
      if (wasPath !== null && nowPath !== null && wasPath !== nowPath) {
        lines.push(`    RELINKED ${before.rawPath}: ${wasPath} -> ${nowPath}`);
      }
      continue;
    }

    const target = pathOf(before);
    const onDisk = target !== null && existsSync(target) ? ' (target exists on disk)' : '';
    lines.push(`    ${before.rawPath}: ${before.resolution} -> ${now.resolution}${onDisk}`);
  }

  if (lines.length === 0) return [];
  return ['  references that changed bucket:', ...lines.slice(0, 25)];
}

function render(comparisons: readonly Comparison[]): string {
  const lines = ['repo                 walked  hand-tuned  detected  missed  extra  agrees'];

  for (const row of comparisons) {
    const agrees = row.missed.length === 0 && row.extra.length === 0;
    lines.push(
      [
        row.repo.padEnd(20),
        String(row.directoriesWalked).padStart(6),
        String(row.handTuned.length).padStart(11),
        String(row.detected.length).padStart(9),
        String(row.missed.length).padStart(7),
        String(row.extra.length).padStart(6),
        agrees ? '  yes' : '  NO',
      ].join(''),
    );
  }

  for (const row of comparisons) {
    if (row.missed.length === 0 && row.extra.length === 0) continue;
    lines.push('', `${row.repo}:`);
    for (const dir of row.missed) lines.push(`  hand-tuned only: ${dir}`);
    for (const dir of row.extra) lines.push(`  detected only:   ${dir}`);
  }

  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const flags = argv.slice(2);
  const only = flags.find((flag) => flag.startsWith('--repo='))?.slice('--repo='.length);
  // The unconfigured duplicates carry no hand-tuned list to compare against; they
  // exist to show what a first run produces, which is what detection replaces.
  const subjects = REPOS.filter(
    (repo) => repo.unconfigured !== true && (only === undefined || repo.name === only),
  );

  // The name set under test, so that a proposed addition can be measured on every
  // repo before it is proposed rather than after.
  const names = flags
    .find((flag) => flag.startsWith('--names='))
    ?.slice('--names='.length)
    .split(',');

  const comparisons: Comparison[] = [];
  for (const repo of subjects) comparisons.push(await compare(repo, names));
  stdout.write(render(comparisons));

  if (!flags.includes('--delta')) return;

  for (const repo of subjects) {
    stdout.write(`\n${(await delta(repo, names)).join('\n')}\n`);
  }
}

await main();
