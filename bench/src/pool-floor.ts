/**
 * Where the parse pool starts paying for itself — R127's measured engagement floor.
 *
 * 🔴 **R127 ruled this number MEASURED before the pool was built**, and the reason is on
 * record: *"a pool is a net LOSS on small inputs. Worker spin-up is tens of milliseconds
 * each, so a watch-mode rescan of three files must not pay for four workers."* It also
 * says where the number must not come from — *"a floor chosen by taste is how
 * `os.cpus() - 1` became a default that is ~21% worse than 4."*
 *
 * ## ✅ Why it is an A/B inside one run, and rotated
 *
 * R143 is the lesson this instrument is built on: a spread measured inside one run is not
 * the drift between runs, and the only shape that has ever survived that drift in this
 * project is **both sides measured together, interleaved**. So at each file count this
 * runs pooled and unpooled **alternately**, starting from the other side on each repeat,
 * and reports the pair rather than two numbers taken apart.
 *
 * ⚠️ **It reports a CROSSOVER, not a recommendation.** The floor that ships is the
 * crossover with margin, and the margin is sized against CI's 2–5% between-invocation
 * spread — because a floor sized on a laptop's noise is sized on nothing (R133).
 *
 * ## ⚠️ What this cannot tell you, stated so the number is not over-read
 *
 * It sweeps the **generated bench tree**, whose file-size distribution was calibrated
 * against three real repositories (R19) but whose AST density per KB has never been
 * checked against real code — R19's own unresolved fourth point. A repository of denser
 * files parses slower per byte and crosses over sooner. **The floor is therefore an upper
 * bound on the crossover for trees like this one, not a fact about every repository.**
 *
 * Reads only; writes nothing anywhere (R52).
 *
 * Usage:
 *   pnpm --filter upfly-bench run pool-floor
 *   pnpm --filter upfly-bench run pool-floor -- --counts=50,100,250,500 --repeats=3
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { cpus, platform } from 'node:os';
import { argv, stdout } from 'node:process';
import {
  type Adapter,
  type Asset,
  DEFAULT_POOL_WORKERS,
  MIN_POOLED_FILES,
  defaultAdapters,
  discover,
  scanSources,
} from 'upfly-core';
import { generateTree } from './generate.js';
import { type Summary, summarise } from './samples.js';

const ADAPTERS: readonly Adapter[] = defaultAdapters;

function basenamesOf(assets: readonly Asset[]): Set<string> {
  return new Set(
    assets.map((asset) => asset.relative.slice(asset.relative.lastIndexOf('/') + 1).toLowerCase()),
  );
}

/** One scan of the first `count` files, pooled or not. Returns milliseconds. */
async function scanOnce(
  sourceFiles: Parameters<typeof scanSources>[0]['sourceFiles'],
  assetBasenames: ReadonlySet<string>,
  pooled: boolean,
): Promise<{ ms: number; engaged: boolean }> {
  const started = performance.now();
  const result = await scanSources({
    sourceFiles,
    adapters: ADAPTERS,
    readFile: (path: string) => readFile(path, 'utf8'),
    assetBasenames,
    // `minFiles: 1` so the pool engages at every count. The floor is what this instrument
    // is measuring, so letting the shipped floor decide would make it agree with itself.
    ...(pooled ? { pool: { minFiles: 1, workers: DEFAULT_POOL_WORKERS } } : {}),
  });
  return { ms: performance.now() - started, engaged: result.pool.engaged };
}

interface Row {
  readonly files: number;
  readonly unpooled: Summary;
  readonly pooled: Summary;
  readonly changePercent: number;
  readonly engaged: boolean;
}

async function main(): Promise<void> {
  const counts = (
    argv.find((flag) => flag.startsWith('--counts='))?.slice('--counts='.length) ??
    '10,25,50,100,200,400,800,1600'
  )
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
  const repeats = Number(
    argv.find((flag) => flag.startsWith('--repeats='))?.slice('--repeats='.length) ?? 3,
  );

  const generated = await generateTree({});
  if (!existsSync(generated.root)) throw new Error(`bench tree missing at ${generated.root}`);

  const found = await discover({ root: generated.root, adapters: ADAPTERS });
  const assetBasenames = basenamesOf(found.assets);

  stdout.write(
    [
      '',
      `parse pool engagement floor — ${platform()}, ${cpus().length} cores, ${DEFAULT_POOL_WORKERS} workers`,
      `  shipped floor: MIN_POOLED_FILES = ${MIN_POOLED_FILES}`,
      `  ${found.sourceFiles.length} source files available; sweeping ${counts.join(', ')}`,
      '  ⚠️ Check for surviving node processes before trusting this (R49-b).',
      '',
    ].join('\n'),
  );

  // One discarded pass so the filesystem cache and the JIT are warm for every row alike.
  await scanOnce(found.sourceFiles.slice(0, 50), assetBasenames, false);

  const rows: Row[] = [];
  for (const count of counts) {
    const sourceFiles = found.sourceFiles.slice(0, count);
    if (sourceFiles.length < count) break;

    const unpooled: number[] = [];
    const pooled: number[] = [];
    let engaged = false;

    for (let repeat = 0; repeat < repeats; repeat++) {
      // 🔴 Alternating, so a machine that drifts during the sweep drifts through BOTH
      // sides of every pair rather than through one of them. This is `noise.ts`'s `--pair`
      // and B11's BEFORE/AFTER/BEFORE bracket, which is the only technique in this project
      // that has ever beaten the drift (R143).
      if (repeat % 2 === 0) {
        unpooled.push((await scanOnce(sourceFiles, assetBasenames, false)).ms);
        const run = await scanOnce(sourceFiles, assetBasenames, true);
        pooled.push(run.ms);
        engaged = run.engaged;
      } else {
        const run = await scanOnce(sourceFiles, assetBasenames, true);
        pooled.push(run.ms);
        engaged = run.engaged;
        unpooled.push((await scanOnce(sourceFiles, assetBasenames, false)).ms);
      }
    }

    const left = summarise(unpooled);
    const right = summarise(pooled);
    rows.push({
      files: count,
      unpooled: left,
      pooled: right,
      changePercent: ((right.medianMs - left.medianMs) / Math.max(1, left.medianMs)) * 100,
      engaged: engaged,
    });
  }

  stdout.write('  files   unpooled    pooled    change   spread(u/p)   verdict\n');
  for (const row of rows) {
    const floor = Math.max(row.unpooled.spreadPercent, row.pooled.spreadPercent);
    const verdict = !row.engaged
      ? 'POOL DID NOT ENGAGE'
      : Math.abs(row.changePercent) <= floor
        ? `inside the ${floor}% spread`
        : row.changePercent < 0
          ? 'pooled WINS'
          : 'pooled loses';
    stdout.write(
      [
        String(row.files).padStart(7),
        `${row.unpooled.medianMs}`.padStart(11),
        `${row.pooled.medianMs}`.padStart(10),
        `${row.changePercent >= 0 ? '+' : ''}${row.changePercent.toFixed(1)}%`.padStart(10),
        `${row.unpooled.spreadPercent}/${row.pooled.spreadPercent}%`.padStart(14),
        `   ${verdict}`,
      ].join(''),
    );
    stdout.write('\n');
  }

  const crossover = rows.find(
    (row) =>
      row.engaged &&
      row.changePercent < 0 &&
      Math.abs(row.changePercent) > Math.max(row.unpooled.spreadPercent, row.pooled.spreadPercent),
  );

  stdout.write(
    [
      '',
      crossover === undefined
        ? "  🔴 NO CROSSOVER in this sweep: the pool never beat the main thread by more than\n     the pair's own spread. Either the counts are too low or the pool is not paying."
        : `  crossover at ${crossover.files} files (${crossover.changePercent.toFixed(1)}%, outside a ${Math.max(crossover.unpooled.spreadPercent, crossover.pooled.spreadPercent)}% spread)`,
      '',
      '  ⚠️ The SHIPPED floor is the crossover with margin, and the margin is sized against',
      "     CI's 2–5% between-invocation spread — never this machine's. R133 showed CI",
      '     resolves differences a laptop cannot see, so a floor sized here is provisional',
      '     until CI has run this sweep (R127).',
      '',
    ].join('\n'),
  );
}

await main();
