/**
 * Lists the shapes that references in the validation repositories carry and the accuracy
 * suite has no instance of: the suite's growth list, taken from real code.
 *
 * It does not measure how far the tree's results hold on real repositories. A reference can
 * only carry a shape the engine declares, and the engine's vocabulary is kept equal to the
 * tree's, so only shapes already known to be untested can appear here, never one nobody has
 * named. The false-negative sweep in `validate.ts` can find such a shape, because it searches
 * the text for filenames and never asks what shape anything is. See "What the tree says about
 * real repositories" in accuracy-suite/README.md.
 *
 * Read-only. Usage: `pnpm --filter upfly-bench run transferability`
 */

import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { stdout } from 'node:process';
import {
  type Reference,
  buildGraph,
  defaultAdapters,
  discover,
  loadAliases,
  resolveReferences,
  scanSources,
} from 'upfly-core/internal';
import { REPOS, VALIDATION_ROOT } from './repos.js';

/** The shapes the accuracy suite has at least one instance of, read from its answer key. */
async function testedShapes(): Promise<ReadonlySet<string>> {
  const keyPath = new URL('../../accuracy-suite/key/answer-key.json', import.meta.url);
  const key = JSON.parse(await readFile(keyPath, 'utf8')) as {
    files: { entries: { shape: string }[] }[];
  };
  const tested = new Set<string>();
  for (const file of key.files) {
    for (const entry of file.entries) tested.add(entry.shape);
  }
  return tested;
}

interface RepoResult {
  readonly name: string;
  readonly references: number;
  readonly inTestedShapes: number;
  /** Count per shape, for the shapes the tree has no instance of. */
  readonly remainder: ReadonlyMap<string, number>;
}

async function classify(root: string, publicDirs: readonly string[]) {
  const readFileText = (path: string) => readFile(path, 'utf8');
  const discovery = await discover({ root, adapters: defaultAdapters });
  const scanned = await scanSources({
    sourceFiles: discovery.sourceFiles,
    adapters: defaultAdapters,
    readFile: readFileText,
    assetBasenames: new Set(
      discovery.assets.map((asset) => asset.relative.split('/').pop()?.toLowerCase() ?? ''),
    ),
  });
  const aliases = await loadAliases({
    root: discovery.root,
    files: [...discovery.sourceFiles, ...discovery.unscannedFiles],
    readFile: readFileText,
    isFile: (path: string) => statSync(path, { throwIfNoEntry: false })?.isFile() === true,
  });
  const references = resolveReferences(scanned.references, {
    root: discovery.root,
    assets: discovery.assets,
    // The declared roots from `repos.ts`, as `validate.ts` runs its configured entries.
    servingRoots: { dirs: publicDirs, declared: true },
    excludedRoots: discovery.excludedRoots,
    aliases,
    exists: (path: string) => existsSync(path),
  });
  // Built, though its result is unused, so this run matches the one the other instruments
  // report on.
  buildGraph({
    root: discovery.root,
    assets: discovery.assets,
    references,
    unscannedFiles: [...discovery.unscannedFiles, ...scanned.unscanned],
  });
  return references;
}

function tally(
  references: readonly Reference[],
  tested: ReadonlySet<string>,
): Omit<RepoResult, 'name'> {
  const remainder = new Map<string, number>();
  let inTestedShapes = 0;
  for (const reference of references) {
    if (tested.has(reference.shape)) {
      inTestedShapes += 1;
      continue;
    }
    remainder.set(reference.shape, (remainder.get(reference.shape) ?? 0) + 1);
  }
  return { references: references.length, inTestedShapes, remainder };
}

const tested = await testedShapes();
const results: RepoResult[] = [];

for (const repo of REPOS) {
  // An unconfigured entry is a second run of a repository already in the table, so
  // including it would count that repository twice.
  if (repo.unconfigured === true) continue;
  const root = `${VALIDATION_ROOT}/${repo.name}`;
  if (!existsSync(root)) {
    stdout.write(`${repo.name}: absent from the corpus, skipped\n`);
    continue;
  }
  const references = await classify(root, repo.publicDirs);
  results.push({ name: repo.name, ...tally(references, tested) });
}

// Per repository and never averaged: `railsgirls-com` holds more references than the other
// four together, so a mean would describe that one repository.
stdout.write('\ntransferability, per repository, and deliberately not averaged.\n');
stdout.write(
  'Coverage of our test shapes is not accuracy. These are counts of references whose shape\n' +
    'the tree has at least one instance of. They say nothing about whether those references\n' +
    'were resolved correctly; that is the matrix, and it is a different table.\n\n',
);

for (const result of results) {
  const outside = [...result.remainder.values()].reduce((total, count) => total + count, 0);
  stdout.write(`${result.name}\n`);
  stdout.write(`  references                  ${result.references}\n`);
  stdout.write(`  in shapes the tree tests    ${result.inTestedShapes}\n`);
  stdout.write(`  in shapes it does not       ${outside}\n`);
  if (result.remainder.size === 0) {
    stdout.write('  remainder: none (every shape in this repository has a tree instance)\n\n');
    continue;
  }
  stdout.write('  remainder, named rather than averaged away:\n');
  for (const [shape, count] of [...result.remainder].sort((a, b) => b[1] - a[1])) {
    stdout.write(`      ${String(count).padStart(6)}  ${shape}\n`);
  }
  stdout.write('\n');
}

/**
 * Every shape the corpus produced that the tree has no instance of: the growth list. Unlike
 * `UNTESTED_SHAPE_IDS`, which lists shapes the engine can emit, every id here occurs in a
 * real repository.
 */
const union = new Map<string, number>();
for (const result of results) {
  for (const [shape, count] of result.remainder) {
    union.set(shape, (union.get(shape) ?? 0) + count);
  }
}
stdout.write(
  'Read this before the numbers above: the fraction is near-vacuous by construction, and\n' +
    'saying so is the finding. A reference can only carry a shape an adapter emits, and a test\n' +
    "that fails in either direction holds that vocabulary identical to the tree's. So the\n" +
    'remainder can only ever contain the handful of shapes already known to have no tree\n' +
    'instance: three on UNTESTED_SHAPE_IDS, three the key declares unkeyable with a reason. A\n' +
    'shape nobody imagined has no id at all, so it cannot appear here: it appears as nothing,\n' +
    'which is the circularity this measurement was built to escape, reproduced inside it.\n' +
    '\n' +
    "The instrument that can see an unimagined shape is validate's false-negative sweep,\n" +
    'because it is a plain text search that never asks the engine what shape anything is. It\n' +
    'found 3,364 filename mentions the graph did not link, adjudicated 638, and found 0 genuine\n' +
    "misses. That is the transferability evidence; the table above is its denominator's shadow.\n\n",
);

stdout.write("the tree's growth list, from reality (shape → references across the corpus):\n");
if (union.size === 0) {
  stdout.write('  none. Every shape the corpus produces has a tree instance.\n');
} else {
  for (const [shape, count] of [...union].sort((a, b) => b[1] - a[1])) {
    stdout.write(`  ${String(count).padStart(6)}  ${shape}\n`);
  }
}
