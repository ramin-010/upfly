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
import { optimizeTree } from './engine-run.js';
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

async function run(name: string, keep: boolean): Promise<boolean> {
  stdout.write(`\n${name}\n`);
  const root = await copyRepository(name);
  stdout.write(`  copy      ${root}\n`);

  try {
    const started = performance.now();
    const result = await optimizeTree(root);
    const seconds = ((performance.now() - started) / 1000).toFixed(1);

    if (result.refusal !== null) {
      stdout.write(`  REFUSED   ${result.refusal.code}: ${result.refusal.reason}\n`);
      return true;
    }

    const { conversions, rewrites, declined } = result.plan;
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

    return true;
  } catch (cause) {
    stdout.write(`  FAILED    ${(cause as Error).message}\n`);
    return false;
  } finally {
    if (keep) stdout.write(`  kept      ${root}\n`);
    else await rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const flags = argv.slice(2);
  const only = flags.find((flag) => flag.startsWith('--repo='))?.slice('--repo='.length);
  const keep = flags.includes('--keep');

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
  for (const name of names) ok = (await run(name, keep)) && ok;

  exit(ok ? 0 : 1);
}

await main();
