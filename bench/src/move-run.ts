/**
 * Move a real repository's images and check the tree still resolves.
 *
 * 🔴 **The one question `relocate`'s tests cannot answer.** The planner is proven
 * against fixtures, and a fixture is a tree whose every reference the graph finds — by
 * construction, because we wrote it. **R39 is about the references the graph MISSES**,
 * and only a repository nobody designed for this engine has those. A move acts on what
 * the graph knows, so a reference it did not find becomes a dangling reference **we
 * caused** rather than one we found.
 *
 * So the check that matters is not *"did it move the file"* — it is **broken before
 * versus broken after**, measured by the same engine over the tree it just wrote. Any
 * reference broken now is one this run broke.
 *
 * ⚠️ **Everything happens on a COPY**, made by `copyRepository`, and `relocateTree`
 * refuses the validation corpus before it reads anything (R52). Every measurement in
 * this project is stated against those pinned commits, and a run that wrote inside one
 * would invalidate all of them while the numbers still looked plausible.
 *
 * Usage: `pnpm --filter upfly-bench run move-run -- --repo=<name> [--keep]`
 */

import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { argv, exit, stdout } from 'node:process';
import sharp from 'sharp';
import type { Move } from 'upfly-core';
import { relocateTree, runEngine } from './engine-run.js';
import { REPOS, VALIDATION_ROOT, refuseValidationCorpus } from './repos.js';

/** Outside the workspace, for the same reason the corpus is. */
const RUN_ROOT = join(VALIDATION_ROOT, '..', 'upfly-move-runs');

/** Never copied: they are large, and nothing the engine reads lives in them. */
const SKIP = new Set(['.git', 'node_modules']);

async function copyRepository(name: string): Promise<string> {
  const source = join(VALIDATION_ROOT, name);
  await mkdir(RUN_ROOT, { recursive: true });
  const destination = await mkdtemp(join(RUN_ROOT, `${name}-`));

  await cp(source, destination, {
    recursive: true,
    filter: (entry) => !SKIP.has(entry.slice(entry.lastIndexOf(sep) + 1)),
  });

  // Belt and braces, as `corpus-run` does it: the destination is built from a constant
  // that cannot point inside the corpus, and this says so rather than trusting that.
  refuseValidationCorpus(destination);
  return destination;
}

async function removeTree(root: string): Promise<void> {
  // libvips holds a handle on every file it has read for the life of the process, which
  // on Windows makes them undeletable by that process. Dropping the cache is the fix;
  // lengthening a retry is folklore.
  sharp.cache(false);
  try {
    await rm(root, { recursive: true, force: true });
  } catch (cause) {
    stdout.write(`  cleanup   left ${root} behind: ${(cause as Error).message}\n`);
  }
}

/**
 * The moves to try, chosen from what the repository actually contains.
 *
 * ⚠️ **Derived from the tree rather than written down.** A hardcoded path would rot the
 * moment the pinned commit changed, and — worse — a path that no longer exists would
 * make this print a clean `not-an-asset` refusal and look like it had run.
 *
 * Two moves, of DIFFERENT assets, chosen to exercise both halves of R70 on real code:
 *   1. one moved **within its own world**, which must proceed and repoint every reference
 *   2. one moved **across** the serving boundary, which must be refused
 *
 * Different assets rather than the same one twice, because moving one file to two
 * places is itself refused (`source-claimed-twice`) and would prove nothing about R70.
 */
function movesFor(assets: readonly string[], servingDirs: readonly string[]): Move[] {
  const served = (path: string) =>
    servingDirs.some((dir) => dir === '' || path === dir || path.startsWith(`${dir}/`));

  const inside = assets.find(served);
  const outside = assets.find((path) => !served(path));
  const moves: Move[] = [];

  // Within its own world: deeper into the directory it already sits in.
  const nearby = inside ?? outside;
  if (nearby !== undefined) moves.push({ from: nearby, to: deeper(nearby) });

  // Across the boundary, in whichever direction this repository makes available.
  const crossing = inside !== undefined && outside !== undefined ? outside : undefined;
  if (crossing !== undefined && inside !== undefined) {
    const target = servingDirs.find((dir) => dir !== '') ?? '';
    const name = crossing.slice(crossing.lastIndexOf('/') + 1);
    moves.push({ from: crossing, to: target === '' ? name : `${target}/upfly-crossed/${name}` });
  }

  return moves;
}

/** The same file, one directory deeper. A move that cannot change how it is referenced. */
function deeper(relative: string): string {
  const cut = relative.lastIndexOf('/');
  const directory = cut === -1 ? '' : relative.slice(0, cut);
  const name = relative.slice(cut + 1);
  return directory === '' ? `upfly-moved/${name}` : `${directory}/upfly-moved/${name}`;
}

async function run(name: string, keep: boolean): Promise<boolean> {
  stdout.write(`\n${name}\n`);
  const root = await copyRepository(name);
  stdout.write(`  copy      ${root}\n`);

  try {
    // Measured before anything is written, so "no new broken references" is a
    // comparison rather than a claim about a number nobody recorded.
    const before = await runEngine(root);
    const brokenBefore = before.graph.byResolution.broken.length;
    const linked = new Set(
      before.graph.references
        .filter((reference) => reference.resolution === 'resolved')
        .map((reference) => reference.resolvedPath),
    );
    const assets = before.graph.assets
      .filter((node) => linked.has(node.asset.path))
      .map((node) => node.asset.relative)
      .sort();

    const moves = movesFor(assets, before.servingRoots.dirs);
    if (moves.length === 0) {
      stdout.write('  SKIPPED   no linked asset to move\n');
      return true;
    }
    for (const move of moves) stdout.write(`  move      ${move.from} -> ${move.to}\n`);

    const { plan, manifest } = await relocateTree(root, moves);

    stdout.write(
      `  plan      ${plan.moves.length} moved, ${plan.rewrites.length} files rewritten, ${plan.refused.length} refused, ${plan.declined.length} declined\n`,
    );
    stdout.write(`  manifest  ${manifest?.state ?? 'none written'}\n`);
    for (const refusal of plan.refused) {
      stdout.write(`    REFUSED ${refusal.code}: ${refusal.reason.slice(0, 120)}\n`);
    }
    for (const rewrite of plan.rewrites.slice(0, 5)) {
      stdout.write(`    ${rewrite.file}  ${rewrite.edits.length} edit(s)\n`);
    }
    if (plan.rewrites.length > 5) {
      stdout.write(`    ... and ${plan.rewrites.length - 5} more files\n`);
    }
    for (const entry of plan.declined.slice(0, 5)) {
      stdout.write(`    declined ${entry.path}: ${entry.reason.slice(0, 100)}\n`);
    }
    if (plan.declined.length > 5) {
      stdout.write(`    ... and ${plan.declined.length - 5} more declined\n`);
    }

    // 🔴 The check that matters. The same engine over the tree it just wrote: any
    // reference broken now is one this run broke.
    const brokenAfter = (await runEngine(root)).graph.byResolution.broken.length;
    stdout.write(`  broken    ${brokenBefore} before, ${brokenAfter} after`);
    stdout.write(brokenAfter > brokenBefore ? '   REGRESSION\n' : '   no regression\n');

    return brokenAfter <= brokenBefore;
  } catch (cause) {
    stdout.write(`  FAILED    ${(cause as Error).message}\n`);
    return false;
  } finally {
    if (keep) stdout.write(`  kept      ${root}\n`);
    else await removeTree(root);
  }
}

async function main(): Promise<void> {
  const flags = argv.slice(2);
  const only = flags.find((flag) => flag.startsWith('--repo='))?.slice('--repo='.length);
  const keep = flags.includes('--keep');

  const names = [...new Set(REPOS.map((repo) => repo.name))].filter(
    (name) => only === undefined || name === only,
  );
  if (names.length === 0) {
    stdout.write(`No repository named ${only}.\n`);
    exit(2);
  }

  stdout.write('\nrelocate, on real repositories. Every run works on a copy.\n');

  let ok = true;
  for (const name of names) ok = (await run(name, keep)) && ok;

  stdout.write(ok ? '\nNO REGRESSION\n' : '\nREGRESSION\n');
  exit(ok ? 0 : 1);
}

await main();
