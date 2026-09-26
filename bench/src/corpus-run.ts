/**
 * Run the engine against a real repository, on a copy, by construction.
 *
 * This points the write path at code nobody wrote for Upfly, where fixtures cannot. It
 * copies the pinned tree and runs against the copy, and no flag makes it do otherwise.
 * `optimizeTree` also refuses the corpus before it reads anything, so a caller that
 * bypassed this file would be refused too.
 */

import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { argv, exit, stdout } from 'node:process';
import sharp from 'sharp';
import { findSurvivingPaths } from 'upfly-core';
import { optimizeTree, runEngine } from './engine-run.js';
import { REPOS, VALIDATION_ROOT, refuseValidationCorpus } from './repos.js';

/**
 * Where copies are made: a sibling of the corpus, never inside it and never inside
 * the workspace.
 *
 * On the corpus's volume so the copy is fast, and outside the workspace because every
 * one of these repositories has image directories and the v2 VS Code extension converts
 * images in a workspace `public/` in place.
 */
const RUN_ROOT = resolve(VALIDATION_ROOT, '..', 'upfly-corpus-runs');

/** Never copied: neither is read by the engine and both dwarf everything else. */
const SKIP = new Set(['.git', 'node_modules']);

async function copyRepository(name: string): Promise<string> {
  const source = join(VALIDATION_ROOT, name);
  await mkdir(RUN_ROOT, { recursive: true });
  const destination = await mkdtemp(join(RUN_ROOT, `${name}-`));

  await cp(source, destination, {
    recursive: true,
    filter: (entry) => !SKIP.has(entry.slice(entry.lastIndexOf(sep) + 1)),
  });

  // Belt and braces. The copy is built from a constant that cannot point inside the
  // corpus, and this says so out loud rather than trusting the arithmetic above.
  refuseValidationCorpus(destination);
  return destination;
}

/**
 * Delete a run copy, after letting go of the files this process still has open.
 *
 * libvips caches operations, and a cached operation keeps its input file open for the
 * life of the process, so on Windows this process cannot delete a file sharp has read,
 * however long it waits. `sharp.cache(false)` releases them. The retry is for a handle
 * another program holds briefly, such as a scanner or the indexer.
 */
async function removeTree(root: string): Promise<void> {
  sharp.cache(false);

  for (let attempt = 0; ; attempt++) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if ((code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY') || attempt >= 6) {
        stdout.write(`  cleanup   left ${root} behind: ${(cause as Error).message}\n`);
        return;
      }
      await new Promise((done) => setTimeout(done, 250 * 2 ** attempt));
    }
  }
}

/** Declined reasons with their counts, most common first. */
function byReason(declined: readonly { readonly reason: string }[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const entry of declined) counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * The originals the run kept, grouped by reason.
 *
 * Without this, a conversion count higher than the delete count reads as an arithmetic
 * slip. An original is kept for more than one reason (outside a served directory, or
 * still needed by a reference), so each kind gets its own line.
 */
function printKeptOriginals(keptOriginals: readonly { asset: string; reason: string }[]): void {
  if (keptOriginals.length === 0) return;
  stdout.write(
    `  kept      ${keptOriginals.length} original${keptOriginals.length === 1 ? '' : 's'}, by reason\n`,
  );
  // One line per kind of reason: the sentence with its quoted specifics (the file, the
  // text, the count) elided, so the kinds group without this file keeping a second copy
  // of the planner's wording.
  const kinds = byReason(
    keptOriginals.map((kept) => ({
      reason: kept.reason.replace(/`[^`]*`/g, '`…`').replace(/ \(and \d+ more\)/g, ''),
    })),
  );
  for (const [reason, count] of kinds) {
    stdout.write(`    ${String(count).padStart(4)}  ${reason}\n`);
  }
  for (const kept of keptOriginals.slice(0, 5)) stdout.write(`    ${kept.asset}\n`);
  if (keptOriginals.length > 5) stdout.write(`    ... and ${keptOriginals.length - 5} more\n`);
}

async function run(name: string, keep: boolean, replace: boolean): Promise<boolean> {
  stdout.write(`\n${name}\n`);
  const root = await copyRepository(name);
  stdout.write(`  copy      ${root}\n`);

  try {
    // Counted before anything is written, so "no new broken references" is a comparison
    // rather than a claim. No probes: this reads a broken count, and `optimizeTree` below
    // measures in its own engine run, with no cap.
    const brokenBefore = (await runEngine(root, undefined, false)).graph.byResolution.broken.length;

    const started = performance.now();
    const result = await optimizeTree(root, undefined, replace ? 'replace' : 'keep-original');
    const seconds = ((performance.now() - started) / 1000).toFixed(1);

    if (result.refusal !== null) {
      stdout.write(`  REFUSED   ${result.refusal.code}: ${result.refusal.reason}\n`);
      return true;
    }

    const { conversions, rewrites, declined, keptOriginals } = result.plan;
    stdout.write(
      `  plan      ${conversions.length} converted, ${rewrites.length} files rewritten, ${declined.length} declined  (${seconds}s)\n`,
    );
    stdout.write(`  manifest  ${result.manifest?.state ?? 'none written'}\n`);

    const saved = conversions.reduce((total, conversion) => total + conversion.savedBytes, 0);
    stdout.write(
      `  saving    ${(saved / 1024).toFixed(0)} KB across ${conversions.length} images\n`,
    );

    for (const conversion of conversions.slice(0, 5)) {
      stdout.write(`    ${conversion.asset} -> ${conversion.target}  ${conversion.savedBytes} B\n`);
    }
    if (conversions.length > 5) stdout.write(`    ... and ${conversions.length - 5} more\n`);

    printKeptOriginals(keptOriginals);

    // Grouped, because many lines of the same sentence tell a reader nothing that one
    // line and a count do not.
    stdout.write('  declined, by reason\n');
    for (const [reason, count] of byReason(declined)) {
      stdout.write(`    ${String(count).padStart(4)}  ${reason}\n`);
    }

    // The check that matters: not whether the run finished but whether the tree still
    // resolves. The same engine over the tree it just wrote, so any reference broken now
    // is one this run broke. No probes here either: this reads the graph, the serving
    // roots and the walk.
    const after = await runEngine(root, undefined, false);
    const brokenAfter = after.graph.byResolution.broken.length;
    stdout.write(`  broken    ${brokenBefore} before, ${brokenAfter} after`);
    stdout.write(brokenAfter > brokenBefore ? '   REGRESSION\n' : '   no regression\n');

    // The count above comes from the same graph that decided which references exist, so
    // it only shows that nothing Upfly can read broke. A file that fails to parse, as some
    // of `railsgirls-com`'s `.html` files do, hides its references from both the rewrite
    // and the count, so every file is searched for the old paths.
    //
    // Only for originals that were deleted: under `keep-original` the source is still on
    // disk, and an unrewritten reference to it still resolves. `replacesOriginal` says
    // which, and existence on disk is checked rather than trusted.
    const deleted: { from: string; to: string }[] = [];
    for (const conversion of conversions) {
      if (!conversion.replacesOriginal) continue;
      if (existsSync(join(root, conversion.asset))) continue;
      deleted.push({ from: conversion.asset, to: conversion.target });
    }

    if (deleted.length === 0) {
      stdout.write('  old paths  no original was deleted, so there is nothing to search for\n');
    } else {
      stdout.write(`\n  searching every file for ${deleted.length} deleted original(s)\n`);
      const survived = await findSurvivingPaths({
        moves: deleted,
        files: [...after.discovery.sourceFiles, ...after.discovery.unscannedFiles].map(
          (file) => file.relative,
        ),
        readFile: (relative) => readFile(join(root, relative), 'utf8'),
        servingDirs: after.servingRoots.dirs,
      });
      for (const line of survived.lines) stdout.write(line === '' ? '\n' : `  ${line}\n`);
    }

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
  const replace = flags.includes('--replace');

  // One run per repository, not one per entry: the unconfigured entries exist to compare
  // reports, and every run here decides its serving roots the same way, so a second
  // entry would repeat the same run.
  const names = [...new Set(REPOS.map((repo) => repo.name))].filter(
    (name) => only === undefined || name === only,
  );

  if (names.length === 0) {
    stdout.write(`No repository named ${only}.\n`);
    exit(2);
  }

  let ok = true;
  if (replace) {
    stdout.write('\npolicy    replace: originals are removed once their references move\n');
  }
  for (const name of names) ok = (await run(name, keep, replace)) && ok;

  exit(ok ? 0 : 1);
}

await main();
