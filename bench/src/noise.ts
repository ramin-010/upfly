/**
 * The noise floor: how much `graphMs` moves when the work does not change at all. An
 * optimisation that claims less than the floor cannot be told from noise.
 *
 * `--invocations` times one repository in N separate processes, `--pair` times two entries
 * whose work is identical (`PAIR`), and `--inject-ms` checks that the gauge sees a known
 * delay (`burn`). The machine's state is the fixture: check that no node process survives
 * from an earlier run, and run nothing beside it. It only reads the corpus.
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

/** The default subject: the configured entry of `PAIR`. */
const DEFAULT_REPO = 'railsgirls-com';

/**
 * The two entries whose difference is measurement error.
 *
 * Same repository, same pinned commit, same 6 496 files. The configured entry declares
 * `['']`; the other detects, which on this repository finds nothing and falls through
 * to the same project-root resolution. Verified identical: 119 `exists()` calls, 10 127
 * references and 111 broken on both sides. Detection is the only extra step, at about
 * 0.08 ms of a 6 s build. The `shadcn-ui` twin is not a gauge: its two entries differ in
 * broken and dead counts, so they do different resolution work.
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
 * A copy of that span rather than a call into `runPipeline`, which also probes, audits
 * and sweeps: folding libvips into a measurement of our own traversal blurs it.
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
  // over a different span is not comparable with the column it is meant to judge. It
  // costs about 0.5 ms on `railsgirls-com`, which has no alias config, and about 170 ms
  // on `shadcn-ui`, which has 62 alias rules.
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

/**
 * Burn `ms` of wall clock, for `--inject-ms`. Synchronous, so nothing overlaps it.
 *
 * A known delay has to land above the floor. A floor nobody has shown to see one is a
 * number, not an instrument.
 */
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

  // `--cold` is what `validate.ts` does: build the graph once, with no warm-up discarded,
  // as the first thing this process does to this tree. The warm median-of-N below is
  // what `bench/run.ts` does. Comparing the two spreads shows whether the noise belongs
  // to the work or to the sampling.
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

/** The pair, back to back inside one process. */
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
