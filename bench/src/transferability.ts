/**
 * R76b: how much of a REAL repository falls into shapes the coverage tree tests?
 *
 * **The honest limit first, because it is the reason this exists.** A built tree answers
 * *“of the shapes we KNOW about, how many do we handle?”* It cannot answer *“of the shapes
 * that EXIST, how many do we handle?”* — a shape nobody imagined does not appear as a
 * failure, **it appears as nothing, because it is not there.** So *“100% of the tree”* is
 * consistent with 60% of the world.
 *
 * 🔴 **R76 HELD THAT THE GAP IS MEASURABLE THIS WAY, AND RUNNING IT SHOWS IT IS NOT.**
 * The design was: classify every reference by shape, ask which shapes the tree instantiates,
 * and name the remainder. Measured across the five repos, the remainder is **one reference**
 * — and it could never have been much more, because **a reference can only carry a shape an
 * adapter emits**, and the vocabulary is held identical to the tree's by a red test (R76,
 * R82). So the remainder is bounded by the seven shapes already known to have no tree
 * instance: four on `UNTESTED_SHAPE_IDS`, three the key declares unkeyable with a reason.
 *
 * ⚠️ **A shape nobody imagined has no id at all, so it cannot appear in the remainder — it
 * appears as nothing. That is R76's own objection, reproduced inside the measurement built
 * to escape it**, and it is this file's finding rather than a caveat on it.
 *
 * ✅ **The instrument that CAN see an unimagined shape is R74's sweep**, because it is a
 * plain text search that never asks the engine what shape anything is: 3,364 filename
 * mentions the graph did not link, 638 adjudicated, 0 genuine misses. **That is the
 * transferability evidence.** What this file still earns its place for is the GROWTH LIST —
 * which named shapes reality actually contains that the tree does not test — and that list
 * is worth keeping accurate even when it is short.
 *
 * 🔴 **NO SINGLE PERCENTAGE IS PRINTED, and that is a hard rule rather than a style
 * choice (R76).** Coverage of our test shapes is **not** accuracy, and the two are
 * conflated the moment they share a page. This prints counts per shape and a named
 * remainder; there is deliberately no figure to lift out of it.
 *
 * ⚠️ **AND NO AVERAGE ACROSS REPOSITORIES.** One `railsgirls-com` would dominate any mean
 * — it holds more references than the other four together — so an average would describe
 * that repository and be quoted as describing the corpus.
 *
 * ## What it is careful about
 *
 * ⚠️ **It runs with the corpus's DECLARED serving roots, from the table in `repos.ts`.**
 * Auto-detection finds directories *named* `public` or `static`; shadcn-ui has twelve
 * declared, and resolving against a sibling app's public directory once produced 93 false
 * `broken` findings (R13). A transferability figure measured on a misconfigured run
 * describes the misconfiguration. This is the third instrument in one week to need that
 * warning, so it is wired to the table rather than restated.
 *
 * ⚠️ **Read-only.** It runs the scan and resolve path, writes nothing, and never touches
 * the pinned corpus — `refuseValidationCorpus` guards the writing paths, and this is not
 * one of them.
 *
 * Usage: `pnpm --filter upfly-bench run transferability`
 */

import { existsSync } from 'node:fs';
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
} from 'upfly-core';
import { REPOS, VALIDATION_ROOT } from './repos.js';

/** Which shapes the tree has at least one instance of — the numerator's definition. */
async function testedShapes(): Promise<ReadonlySet<string>> {
  const keyPath = new URL('../../coverage-tree/key/coverage-key.json', import.meta.url);
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
  /** Shape → count, for shapes the tree has NO instance of. The named remainder. */
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
    exists: (path: string) => existsSync(path),
  });
  const references = resolveReferences(scanned.references, {
    root: discovery.root,
    assets: discovery.assets,
    // Declared, from the table. See the note at the top of this file.
    servingRoots: { dirs: publicDirs, declared: true },
    excludedRoots: discovery.excludedRoots,
    aliases,
    exists: (path: string) => existsSync(path),
  });
  // The graph is built so this run matches the one every other instrument reports on,
  // rather than measuring a pipeline nobody else uses.
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
  // The unconfigured twins measure root INFERENCE, which is R71's question and a different
  // instrument's. Including them here would count the same repository twice.
  if (repo.unconfigured === true) continue;
  const root = `${VALIDATION_ROOT}/${repo.name}`;
  if (!existsSync(root)) {
    stdout.write(`${repo.name}: absent from the corpus, skipped\n`);
    continue;
  }
  const references = await classify(root, repo.publicDirs);
  results.push({ name: repo.name, ...tally(references, tested) });
}

stdout.write('\nR76b — transferability. Per repository, and DELIBERATELY NOT AVERAGED.\n');
stdout.write(
  '🔴 Coverage of our test shapes is NOT accuracy. These are counts of references whose SHAPE\n' +
    '   the tree has at least one instance of. They say nothing about whether those references\n' +
    '   were resolved correctly — that is the matrix, and it is a different table.\n\n',
);

for (const result of results) {
  const outside = [...result.remainder.values()].reduce((total, count) => total + count, 0);
  stdout.write(`${result.name}\n`);
  stdout.write(`  references                  ${result.references}\n`);
  stdout.write(`  in shapes the tree tests    ${result.inTestedShapes}\n`);
  stdout.write(`  in shapes it does NOT       ${outside}\n`);
  if (result.remainder.size === 0) {
    stdout.write('  remainder: none — every shape in this repository has a tree instance\n\n');
    continue;
  }
  stdout.write('  🔴 THE REMAINDER, NAMED rather than averaged away:\n');
  for (const [shape, count] of [...result.remainder].sort((a, b) => b[1] - a[1])) {
    stdout.write(`      ${String(count).padStart(6)}  ${shape}\n`);
  }
  stdout.write('\n');
}

/**
 * The union of every shape the corpus produced that the tree has no instance of.
 *
 * ✅ **This is the growth list R76 promised, arriving from reality rather than from
 * imagination** — and unlike `UNTESTED_SHAPE_IDS`, which lists constructs somebody noticed
 * the engine could emit, every id here is one a real repository actually contains.
 */
const union = new Map<string, number>();
for (const result of results) {
  for (const [shape, count] of result.remainder) {
    union.set(shape, (union.get(shape) ?? 0) + count);
  }
}
stdout.write(
  '🔴 READ THIS BEFORE THE NUMBERS ABOVE: THE FRACTION IS NEAR-VACUOUS BY CONSTRUCTION, and\n' +
    '   saying so is the finding. A reference can only carry a shape an ADAPTER EMITS, and the\n' +
    "   vocabulary is held identical to the tree's by a red test (R76, R82). So the remainder can\n" +
    '   only ever contain the handful of shapes already known to have no tree instance — four on\n' +
    '   UNTESTED_SHAPE_IDS, three the key declares unkeyable with a reason. A shape NOBODY\n' +
    '   IMAGINED has no id at all, so it cannot appear here: it appears as nothing, which is\n' +
    "   R76's own objection reproduced inside the measurement built to escape it.\n" +
    '\n' +
    "   ✅ THE INSTRUMENT THAT CAN SEE AN UNIMAGINED SHAPE IS R74'S SWEEP, because it is a plain\n" +
    '   text search that never asks the engine what shape anything is. It found 3,364 filename\n' +
    '   mentions the graph did not link, adjudicated 638, and found 0 genuine misses. THAT is\n' +
    "   the transferability evidence; the table above is its denominator's shadow.\n\n",
);

stdout.write("the tree's growth list, from reality (shape → references across the corpus):\n");
if (union.size === 0) {
  stdout.write('  none. Every shape the corpus produces has a tree instance.\n');
} else {
  for (const [shape, count] of [...union].sort((a, b) => b[1] - a[1])) {
    stdout.write(`  ${String(count).padStart(6)}  ${shape}\n`);
  }
}
