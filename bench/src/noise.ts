/**
 * The noise floor: how much `graphMs` moves when the work does not change at all.
 *
 * 🔴 **Why this exists before any optimisation.** §5.1(g) failed at ~12 500 ms against
 * a 3 000 ms budget, and the obvious next move is to make the graph build faster. It is
 * not the next move. Two chats independently measured this instrument disagreeing with
 * itself by **47%** and **37%** on identical work, with the direction flipping between
 * runs. **An "improvement" smaller than that is a coin flip**, and the cost of getting
 * it wrong is not a wasted afternoon — it is a number written into the build plan as a
 * fact. B4 already threw away a 40-minute run on a contention story that was wrong.
 *
 * **Two things are measured here, and they answer different questions.**
 *
 * 1. `--invocations` — the **floor**. One repository, the same work, N separate
 *    processes. Whatever spread comes back is what an optimisation must beat before
 *    anybody believes it. Separate processes rather than N loops in one, for the reason
 *    `invocations.ts` gives: the in-process sampler controls the filesystem cache and
 *    nothing else.
 *
 * 2. `--pair` — the **free gauge nobody had used.** `railsgirls-com` and
 *    `railsgirls-com-unconfigured` walk the same 6 496 files and build the same 10 127
 *    references, so their difference inside one run is measurement error and nothing
 *    else. ⚠️ That claim was checked rather than assumed, because `graphMs` spans the
 *    serving-root step and the two entries take different branches through it:
 *    `detectServingRoots` costs **0.083 ms** median over railsgirls' 443 directories,
 *    both branches make **exactly 119 `exists()` calls**, and both produce 10 127
 *    references and 111 broken. So the systematic term is ~0.001% of a ~6 000 ms build
 *    and the pair is clean. **The `shadcn-ui` pair is NOT** — same files and references
 *    but 20 vs 1 broken and 8 vs 125 dead, so it does genuinely different resolution
 *    work. Both twins look alike in `SUMMARY.md`; only one is an instrument.
 *
 * ✅ **`--inject-ms` is the gauge's own mutation test**, and it is the reason this is a
 * committed instrument rather than a scratch script. A floor nobody has shown to be
 * sensitive is a number, not an instrument — *"a test whose guard never fires proves
 * nothing"* applies to a benchmark exactly as it does to a suite. Injecting a known
 * delay and confirming it lands above the floor is what separates the two.
 *
 * ⚠️ **For a benchmark the fixture is the machine state.** Check for surviving
 * processes before trusting any run of this (R49-b has bitten twice), and do not run it
 * beside anything else. Reads only; it never writes inside the corpus (R52).
 *
 * Usage:
 *   pnpm --filter upfly-bench run noise -- --invocations=7 --runs=3
 *   pnpm --filter upfly-bench run noise -- --pair --runs=3
 *   pnpm --filter upfly-bench run noise -- --invocations=5 --runs=3 --inject-ms=600
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { cpus, platform } from 'node:os';
import { join } from 'node:path';
import { argv, exit, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  type Adapter,
  type Asset,
  type ServingRoots,
  buildGraph,
  defaultAdapters,
  detectServingRoots,
  discover,
  loadAliases,
  resolveReferences,
  scanSources,
} from 'upfly-core';
import { VALIDATION_ROOT } from './repos.js';
import { type Summary, summarise } from './samples.js';

const exec = promisify(execFile);
const ADAPTERS: readonly Adapter[] = defaultAdapters;

/** The default subject: the larger half of the pair, and the one both chats measured. */
const DEFAULT_REPO = 'railsgirls-com';

/**
 * The two entries whose difference is measurement error.
 *
 * Same repository, same pinned commit, same 6 496 files. The configured entry declares
 * `['']`; the other detects, which on this repository finds nothing and falls through
 * to the same project-root resolution. Verified identical: 119 `exists()` calls, 10 127
 * references and 111 broken on both sides.
 */
const PAIR: readonly { readonly label: string; readonly declared: ServingRoots | null }[] = [
  { label: 'railsgirls-com', declared: { dirs: [''], declared: true } },
  { label: 'railsgirls-com-unconfigured', declared: null },
];

/** Lowercased asset basenames, for the mention pass `scan` does while reading. */
function basenamesOf(assets: readonly Asset[]): Set<string> {
  return new Set(
    assets.map((asset) => asset.relative.slice(asset.relative.lastIndexOf('/') + 1).toLowerCase()),
  );
}

/**
 * One graph build, timed exactly as `pipeline.ts` times `graphMs`.
 *
 * Deliberately a copy of that span rather than a call into `runPipeline`: the pipeline
 * also probes, audits and sweeps, and folding libvips into a measurement of our own
 * traversal is how the 77%-parsing finding got muddled in the first place.
 */
async function buildOnce(root: string, declared: ServingRoots | null): Promise<number> {
  const readFileText = (path: string) => readFile(path, 'utf8');
  const started = performance.now();

  const discovery = await discover({ root, adapters: ADAPTERS });
  const scanned = await scanSources({
    sourceFiles: discovery.sourceFiles,
    adapters: ADAPTERS,
    readFile: readFileText,
    assetBasenames: basenamesOf(discovery.assets),
  });
  // Inside the span because `pipeline.ts` has it inside `graphMs`, and a floor measured
  // over a different span is not comparable with the column it is meant to judge.
  // Measured before being included: 0.5 ms on `railsgirls-com` (no config to read) but
  // **169.8 ms, min 157.6 max 198.4, on `shadcn-ui`**, which has 62 real alias rules.
  // Negligible for the default subject; not negligible for every subject.
  const aliases = await loadAliases({
    root: discovery.root,
    files: [...discovery.sourceFiles, ...discovery.unscannedFiles],
    readFile: readFileText,
    exists: (path) => existsSync(path),
  });
  const servingRoots = declared ?? detectServingRoots(discovery);
  const references = resolveReferences(scanned.references, {
    root: discovery.root,
    assets: discovery.assets,
    servingRoots,
    excludedRoots: discovery.excludedRoots,
    aliases,
    exists: (path) => existsSync(path),
  });
  buildGraph({
    root: discovery.root,
    assets: discovery.assets,
    references,
    unscannedFiles: [...discovery.unscannedFiles, ...scanned.unscanned],
  });

  return performance.now() - started;
}

/** Burn `ms` of wall clock, for `--inject-ms`. Synchronous, so nothing overlaps it. */
function burn(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // Intentionally spinning: a timer would yield to the event loop and measure
    // something other than "this build got slower".
  }
}

/** The child: K builds of one tree, warm-up discarded, median to stdout as JSON. */
async function child(): Promise<void> {
  const repo = flagValue('--repo') ?? DEFAULT_REPO;
  const runs = Number(flagValue('--runs') ?? 3);
  const injectMs = Number(flagValue('--inject-ms') ?? 0);
  const unconfigured = argv.includes('--unconfigured');
  const root = join(VALIDATION_ROOT, repo);
  const declared = unconfigured ? null : { dirs: [''], declared: true };

  // 🔴 `--cold` is what `validate.ts` actually does: build the graph ONCE, with no
  // warm-up discarded, as the first thing this process does to this tree. The warm
  // median-of-N below is what `bench/run.ts` does. Comparing the two spreads is how we
  // find out whether the 47% on record is a property of the work or of the sampling.
  const cold = argv.includes('--cold');
  if (!cold) await buildOnce(root, declared); // warm-up, discarded

  const times: number[] = [];
  for (let index = 0; index < (cold ? 1 : runs); index++) {
    const ms = await buildOnce(root, declared);
    if (injectMs > 0) burn(injectMs);
    times.push(ms + injectMs);
  }

  stdout.write(JSON.stringify(summarise(times)));
}

/** The floor: N separate processes over the same tree. */
async function floor(invocations: number, runs: number, repo: string, injectMs: number) {
  const script = fileURLToPath(new URL('noise.js', import.meta.url));
  const medians: number[] = [];
  const internal: number[] = [];

  for (let index = 0; index < invocations; index++) {
    const args = [script, '--child', `--repo=${repo}`, `--runs=${runs}`];
    if (injectMs > 0) args.push(`--inject-ms=${injectMs}`);
    if (argv.includes('--cold')) args.push('--cold');
    const { stdout: out } = await exec(process.execPath, args, { maxBuffer: 8 * 1024 * 1024 });
    const parsed = JSON.parse(out) as Summary;
    medians.push(parsed.medianMs);
    internal.push(parsed.spreadPercent);
    stdout.write(
      `  invocation ${index + 1}: ${parsed.medianMs} ms  (internal ${parsed.spreadPercent}%, runs ${parsed.allMs.join(', ')})\n`,
    );
  }

  return { across: summarise(medians), internal };
}

/** The pair, inside one process, which is how both earlier measurements were taken. */
async function pair(runs: number): Promise<void> {
  const results: { label: string; summary: Summary }[] = [];

  for (const entry of PAIR) {
    const root = join(VALIDATION_ROOT, 'railsgirls-com');
    await buildOnce(root, entry.declared); // warm-up, discarded
    const times: number[] = [];
    for (let index = 0; index < runs; index++) times.push(await buildOnce(root, entry.declared));
    const summary = summarise(times);
    results.push({ label: entry.label, summary });
    stdout.write(
      `  ${entry.label.padEnd(30)} ${summary.medianMs} ms  (runs ${summary.allMs.join(', ')})\n`,
    );
  }

  const [first, second] = results;
  if (first === undefined || second === undefined) return;
  const difference = Math.abs(first.summary.medianMs - second.summary.medianMs);
  const base = Math.min(first.summary.medianMs, second.summary.medianMs);
  stdout.write(
    `\n  identical work, ${difference} ms apart = ${base === 0 ? 0 : Math.round((difference / base) * 100)}% of the faster side.\n`,
  );
  stdout.write('  That difference is measurement error: the two builds do the same work.\n');
}

function flagValue(name: string): string | undefined {
  return argv.find((flag) => flag.startsWith(`${name}=`))?.slice(name.length + 1);
}

async function main(): Promise<void> {
  if (argv.includes('--child')) {
    await child();
    return;
  }

  const runs = Number(flagValue('--runs') ?? 3);
  const repo = flagValue('--repo') ?? DEFAULT_REPO;
  const injectMs = Number(flagValue('--inject-ms') ?? 0);

  stdout.write(
    `\nnoise floor — ${platform()}, ${cpus().length} cores, UV_THREADPOOL_SIZE=${process.env.UV_THREADPOOL_SIZE ?? '4 (default)'}\n`,
  );
  stdout.write('⚠️ Check for surviving node processes before trusting this (R49-b).\n');

  if (argv.includes('--pair')) {
    stdout.write(`\nThe pair — identical work, one process, median of ${runs} each:\n`);
    await pair(runs);
  }

  const invocations = Number(flagValue('--invocations') ?? 0);
  if (invocations > 0) {
    stdout.write(
      `\nThe floor — ${repo}, ${invocations} separate processes, median of ${runs} each${
        injectMs > 0 ? `, +${injectMs} ms injected per run` : ''
      }:\n`,
    );
    const { across, internal } = await floor(invocations, runs, repo, injectMs);
    stdout.write(
      [
        '',
        `  median of medians : ${across.medianMs} ms`,
        `  min / max         : ${across.minMs} / ${across.maxMs} ms`,
        `  🔴 NOISE FLOOR    : ${across.spreadPercent}% between invocations of identical work`,
        `  spread inside each: ${internal.map((value) => `${value}%`).join(', ')}`,
        '',
        `  Any optimisation claiming less than ${across.spreadPercent}% on this machine is not measurable here.`,
        '',
      ].join('\n'),
    );
  }

  if (invocations === 0 && !argv.includes('--pair')) {
    stdout.write('\nNothing asked for. Pass --invocations=N and/or --pair.\n');
    exit(2);
  }
}

await main();
