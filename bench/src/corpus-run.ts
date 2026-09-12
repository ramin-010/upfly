/**
 * Run the engine against a real repository, on a copy, by construction.
 *
 * The planner had never run on a repository nobody wrote for it, and `optimize` had
 * only ever run on fixtures. This is the first thing that points the write path at
 * real code.
 *
 * 🔴 It copies the pinned tree and runs against the copy, and there is no flag that
 * makes it do otherwise. That is R52's first layer: the safe path is the only path,
 * rather than something a person has to remember at two in the morning. The second
 * layer is `refuseValidationCorpus`, which `optimizeTree` calls before it reads
 * anything, so even a caller who bypassed this file would be refused.
 *
 * Every measurement this project quotes is stated against those pinned commits, and a
 * converted image still reads as an image, so the damage would be invisible until a
 * number stopped reproducing days later.
 */

import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { argv, exit, stdout } from 'node:process';
import sharp from 'sharp';
import { optimizeTree, runEngine } from './engine-run.js';
import { REPOS, VALIDATION_ROOT, refuseValidationCorpus } from './repos.js';

/**
 * Where copies are made: a sibling of the corpus, never inside it and never inside
 * the workspace.
 *
 * Same volume as the corpus so the copy is a fast intra-volume operation, and outside
 * the workspace because every one of these repositories has image directories and the
 * v2 extension converts images in an in-repo `public/` in place.
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
 * 🔴 The handle is ours, and the first version of this got that wrong. A recursive
 * remove failed with EBUSY on a `.webp` the run had just written, so this retried with
 * backoff on the assumption that a scanner or the indexer was holding it briefly.
 * **Six retries over sixteen seconds failed on the same file both times, and a fresh
 * shell deleted it instantly.** A handle nobody is going to release does not care how
 * long you wait.
 *
 * libvips keeps an operation cache of open images, and the re-audit above probes every
 * file the run just wrote, so those stay open for the lifetime of the process.
 * `sharp.cache(false)` drops it. The retry is kept for the genuinely transient case,
 * but it is no longer the mechanism.
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

async function run(name: string, keep: boolean, replace: boolean): Promise<boolean> {
  stdout.write(`\n${name}\n`);
  const root = await copyRepository(name);
  stdout.write(`  copy      ${root}\n`);

  try {
    // Measured before anything is written, so "no new broken references" is a
    // comparison rather than a claim about a number nobody recorded.
    const brokenBefore = (await runEngine(root)).graph.byResolution.broken.length;

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

    // R66. The absence of this line is what made 374 conversions and 373 deletes read
    // as an arithmetic slip: the behaviour was right and nothing said so.
    if (keptOriginals.length > 0) {
      stdout.write(
        `  kept      ${keptOriginals.length} original${keptOriginals.length === 1 ? '' : 's'}, outside a served directory where a missed reference breaks the build\n`,
      );
      for (const kept of keptOriginals.slice(0, 5)) stdout.write(`    ${kept.asset}\n`);
      if (keptOriginals.length > 5) {
        stdout.write(`    ... and ${keptOriginals.length - 5} more\n`);
      }
    }

    // R54 asked what this number actually says. Grouped, because 44 lines of the
    // same sentence tells a reader nothing that one line and a count does not.
    stdout.write('  declined, by reason\n');
    for (const [reason, count] of byReason(declined)) {
      stdout.write(`    ${String(count).padStart(4)}  ${reason}\n`);
    }

    // The check that matters. Rewriting references is the whole product, so the
    // question is not whether it ran but whether the tree still resolves after it.
    // The same engine over the tree it just wrote: any reference broken now is one
    // this run broke.
    const after = await runEngine(root);
    const brokenAfter = after.graph.byResolution.broken.length;
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
  // The replace policy deletes originals once their references have moved. It is
  // shipped code that had never been executed, because every runner hardcoded
  // keep-original, so there was no way to reach it without editing source.
  const replace = flags.includes('--replace');

  // One entry per repository, not one per configuration: the unconfigured duplicates
  // exist to compare reports and there is nothing different to apply for them.
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
