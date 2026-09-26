/**
 * Whether serving-root detection finds the serving roots the validation corpus lists by
 * hand. Accuracy is measured with those hand-tuned lists and a first run has none, so this
 * checks that detection finds the same roots. It reads the same `REPOS` table as
 * `validate.ts`, so the two cannot drift apart, and it reports differences rather than
 * asserting agreement.
 *
 * `--delta` also resolves every reference under each set of roots, since agreeing on the
 * directories is weaker than resolving the references the same way; it shows whether a
 * disagreement costs anything. See "Serving roots" in ARCHITECTURE.md.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { argv, stdout } from 'node:process';
import {
  type Adapter,
  type Asset,
  CONVENTIONAL_SERVING_ROOTS,
  type Reference,
  type ServingRoots,
  buildGraph,
  decideServingRoots,
  defaultAdapters,
  detectServingRoots,
  discover,
  loadAliases,
  resolutionHealth,
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
 * them as a difference would report a disagreement that does not exist: on
 * `railsgirls-com` the two give identical findings.
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
  const detected = detectServingRoots(discovery, names).dirs;
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

/** Every reference resolved under each set of serving roots, compared with the configured run. */
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

  // The single `['public']` convention guess, kept as a baseline: it shows what detection
  // and inference gain over it.
  const guess = resolveWith(CONVENTIONAL_SERVING_ROOTS);
  const auto = resolveWith(detectServingRoots(discovery, names));

  // Detection plus inference, as `decideServingRoots` gives a first run. Inference exists
  // for roots no naming rule reaches, such as `eleventy-docs`' `src/`. Measure it against
  // `configured`, the answer: a root that resolves what the configured run resolves is a
  // gain, and one that relinks a reference elsewhere is the expensive failure that
  // `MIN_ROOT_REFERENCES` and `MIN_ROOT_RESOLUTION_RATE` guard against, which `changed` names.
  const decision = decideServingRoots({
    root: discovery.root,
    directories: discovery.directories,
    assets: discovery.assets,
    sourceFiles: discovery.sourceFiles,
    unscannedFiles: discovery.unscannedFiles,
    references: scanned.references,
    ...(names === undefined ? {} : { names }),
  });
  const inferred = resolveWith(decision.servingRoots);

  // The engine's own `resolutionHealth`, not the same sum written out again. Its floor was
  // chosen from these numbers, and a second copy could put this table and the product on
  // opposite sides of it.
  const health = (references: readonly Reference[]): string => {
    const graph = buildGraph({
      root: discovery.root,
      assets: discovery.assets,
      references,
      unscannedFiles: [...discovery.unscannedFiles, ...scanned.unscanned],
    });
    const { linked, checkable, rate, servingRootUnknown } = resolutionHealth(graph);
    const share = checkable === 0 ? 'n/a' : `${(rate * 100).toFixed(1)}%`;
    return `${linked}/${checkable} root-relative linked (${share})${servingRootUnknown ? '  SERVING ROOT UNKNOWN' : ''}`;
  };

  // `''` is the project root and is a real answer, not an absent one. Printed as a blank
  // it reads as nothing happening, which is the one rendering this table must not do.
  const name = (dir: string) => (dir === '' ? '(project root)' : dir);
  const added = decision.added.length === 0 ? 'none' : decision.added.map(name).join(', ');
  const ties =
    decision.inferred.ties.length === 0
      ? ''
      : `  ties refused (R132): ${decision.inferred.ties
          .map((tie) => `${name(tie.dir)} -> ${tie.candidates.map(name).join(' | ')}`)
          .join(' · ')}
`;

  return [
    // Both counts, because they differ: the resolver leaves out references to files the
    // engine does not track, such as fonts, and the tables below count what it returns.
    `${repo.name}: ${scanned.references.length} scanned, ${configured.length} resolved against`,
    // Read downwards from `guess`: each row answers the same question better than the one
    // above it, and `configured`, on top, is the answer itself.
    `  configured: ${health(configured)}   <- the hand-tuned list, i.e. the ANSWER`,
    `  guess:      ${health(guess)}   <- frozen ['public'], what validate.ts still does`,
    `  detected:   ${health(auto)}`,
    `  inferred:   ${health(inferred)}`,
    // Printed even when nothing was added: an inference that added nothing and one that had
    // no references to score give the same empty answer, and only the count tells them apart.
    `  R132 added: ${added}   (from ${decision.assetReferences} root-relative asset references)`,
    ties,
    '  GUESS against configured:',
    ...table(configured, guess, 'guess'),
    ...changed(configured, guess),
    '  DETECTED against configured:',
    ...table(configured, auto, 'detected'),
    ...changed(configured, auto),
    '  INFERRED against configured:',
    ...table(configured, inferred, 'inferred'),
    ...changed(configured, inferred),
  ];
}

function countByResolution(references: readonly Reference[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const reference of references) {
    counts.set(reference.resolution, (counts.get(reference.resolution) ?? 0) + 1);
  }
  return counts;
}

function table(
  configured: readonly Reference[],
  auto: readonly Reference[],
  rightLabel: string,
): string[] {
  const left = countByResolution(configured);
  const right = countByResolution(auto);
  const kinds = [...new Set([...left.keys(), ...right.keys()])].sort();

  const lines = [`  resolution            configured   ${rightLabel.padEnd(8)}   delta`];
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
 * The references the two runs disagree about, named rather than counted.
 *
 * A bucket delta says how many moved; this says which, and whether the file the configured
 * run linked is on disk, which makes a `broken` in the other run a false one. A false
 * `broken` is the cheap failure and a false link the expensive one, so the two have to be
 * told apart by looking, not by totalling.
 */
function changed(configured: readonly Reference[], auto: readonly Reference[]): string[] {
  const after = new Map(auto.map((reference, index) => [index, reference]));
  const lines: string[] = [];

  for (const [index, before] of configured.entries()) {
    const now = after.get(index);
    if (now === undefined) continue;

    // Same bucket, different file. Counts alone cannot see this, and it is the
    // expensive direction: a reference that still resolves, but somewhere else, is a
    // false link, and a rewrite would act on it.
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
  // The unconfigured entries have no hand-tuned list to compare with: they show what a
  // first run produces.
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
