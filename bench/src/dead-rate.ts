/**
 * The false-`dead` rate on any repository: each `dead` and `possibly-dead` finding, or an
 * even sample, checked by the independent oracle in `verify.ts`. A false `dead` calls a file
 * in use safe to remove, and a count of false `broken` findings cannot see it. `validate.ts`
 * runs the same oracle over the five validation repositories; this points it at any
 * repository. See "Scoring references for accuracy" in ARCHITECTURE.md.
 *
 * It is meant for someone's working repository, so it runs the audit only, never an
 * optimize, and writes nothing but the `--out` file.
 *
 * Usage: `pnpm --filter upfly-bench run dead-rate -- --root=<repo> --public=public`, with
 * `--sample=50` to check an even sample and `--out=<file>` for every verdict in Markdown.
 */

import { appendFileSync, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { argv, exit, stdout } from 'node:process';
import {
  type Adapter,
  audit,
  buildGraph,
  buildReport,
  defaultAdapters,
  detectConventionRoots,
  discover,
  resolveReferences,
  scanSources,
  sweepForMentions,
} from 'upfly-core';
import { type ItemVerdict, verifyFindings } from './verify.js';

const ADAPTERS: readonly Adapter[] = defaultAdapters;

interface Options {
  readonly root: string;
  readonly publicDirs: readonly string[];
  readonly sample: number;
  readonly out: string | null;
}

function parseOptions(): Options {
  const flags = new Map<string, string>();
  for (const argument of argv.slice(2)) {
    const match = /^--([\w-]+)=(.*)$/.exec(argument);
    if (match?.[1] !== undefined) flags.set(match[1], match[2] ?? '');
  }

  const root = flags.get('root');
  if (root === undefined || root === '') {
    stdout.write('--root=<path> is required\n');
    exit(2);
  }
  if (!existsSync(root)) {
    stdout.write(`--root does not exist: ${root}\n`);
    exit(2);
  }

  return {
    root: resolve(root),
    publicDirs: (flags.get('public') ?? 'public').split(',').filter((entry) => entry !== ''),
    // 0 means every `dead` finding. A sample exists only for comparability with a
    // hand-checked number; verifying all of them is strictly better when affordable.
    sample: Number(flags.get('sample') ?? '0'),
    out: flags.get('out') ?? null,
  };
}

/**
 * Progress, written synchronously to stderr. Written to piped stdout it can stay invisible
 * until the run ends, and a long run that prints nothing looks like a hang.
 */
function stage(label: string, since: number): number {
  const now = performance.now();
  appendFileSync(
    2,
    `  [${((now - since) / 1000).toFixed(1)}s] ${label}
`,
  );
  return now;
}

async function main(): Promise<void> {
  const options = parseOptions();
  const readFileText = (path: string) => readFile(path, 'utf8');
  let mark = performance.now();

  stdout.write(
    `§5.1(j) false-dead rate\n  root: ${options.root}\n  public: ${options.publicDirs.join(', ') || '(none)'}\n\n`,
  );

  const discovery = await discover({ root: options.root, adapters: ADAPTERS });
  mark = stage('discover', mark);
  const scanned = await scanSources({
    sourceFiles: discovery.sourceFiles,
    adapters: ADAPTERS,
    readFile: readFileText,
    assetBasenames: new Set(
      discovery.assets.map((asset) =>
        asset.relative.slice(asset.relative.lastIndexOf('/') + 1).toLowerCase(),
      ),
    ),
  });
  mark = stage('scan', mark);
  const references = resolveReferences(scanned.references, {
    root: discovery.root,
    assets: discovery.assets,
    servingRoots: { dirs: options.publicDirs, declared: true },
    excludedRoots: discovery.excludedRoots,
    exists: (path) => existsSync(path),
  });
  const graph = buildGraph({
    root: discovery.root,
    assets: discovery.assets,
    references,
    unscannedFiles: [...discovery.unscannedFiles, ...scanned.unscanned],
  });
  mark = stage('resolve + graph', mark);
  const sweep = await sweepForMentions({
    graph,
    readFile: readFileText,
    scannedMentions: scanned.mentions,
    publicDirs: options.publicDirs,
  });

  mark = stage('sweep', mark);
  // No probe: `dead` does not depend on a measurement, and decoding thousands of images
  // would dominate the runtime of a check that is about correctness.
  const auditResult = await audit({
    graph,
    conventionRoots: detectConventionRoots([
      ...discovery.sourceFiles.map((file) => file.relative),
      ...discovery.unscannedFiles.map((file) => file.relative),
    ]),
    sweep,
    readFile: readFileText,
    publicDirs: options.publicDirs,
  });
  const report = buildReport({
    graph,
    audit: auditResult,
    discovery,
    servingRoots: { dirs: options.publicDirs, declared: true },
    sweep,
    includeUnusedVectors: true,
  });

  mark = stage('audit + report', mark);
  stdout.write(
    `  ${discovery.sourceFiles.length} source files, ${discovery.assets.length} images, ${graph.references.length} references\n`,
  );

  const verified = await verifyFindings(options.root, report, options.publicDirs);
  mark = stage('verify (oracle index + verdicts)', mark);
  report_(report, verified, options);
}

/** Everything the run concluded, as numbers a person can quote. */
function report_(
  report: ReturnType<typeof buildReport>,
  verified: Awaited<ReturnType<typeof verifyFindings>>,
  options: Options,
): void {
  const unreferenced = verified.items.filter(
    (item) => item.kind === 'dead' || item.kind === 'possibly-dead',
  );
  const confident = unreferenced.filter((item) => item.kind === 'dead');

  stdout.write(
    `  ${report.findings.length} findings itemised, ${report.unusedVectors.count} unreferenced SVGs counted\n`,
  );
  stdout.write(
    `  oracle indexed ${verified.filesIndexed} files, grepped ${verified.filesGrepped}\n\n`,
  );

  print('confident `dead`', confident, options.sample);
  print('all unreferenced (`dead` + `possibly-dead`)', unreferenced, options.sample);

  if (verified.unreadable.length > 0) {
    stdout.write(`\n  ⚠️ the oracle could not read ${verified.unreadable.length} file(s):\n`);
    for (const entry of verified.unreadable.slice(0, 5)) stdout.write(`      ${entry}\n`);
  }

  if (options.out !== null) void writeDetail(options.out, unreferenced);
}

/**
 * The rate, and the sample it came from. The sample is every Nth item of the sorted list,
 * never a random draw, so anyone can reproduce the rate.
 */
function print(label: string, items: readonly ItemVerdict[], sample: number): void {
  const ordered = [...items].sort((a, b) => (a.subject < b.subject ? -1 : 1));
  const chosen =
    sample > 0 && sample < ordered.length
      ? ordered
          .filter((_, index) => index % Math.floor(ordered.length / sample) === 0)
          .slice(0, sample)
      : ordered;

  const wrong = chosen.filter((item) => item.verdict === 'confirmed-false');
  const unclear = chosen.filter((item) => item.verdict === 'ambiguous');
  const rate = chosen.length === 0 ? 0 : (wrong.length / chosen.length) * 100;

  stdout.write(`  ${label}\n`);
  stdout.write(`      population      ${ordered.length}\n`);
  stdout.write(
    `      checked         ${chosen.length}${chosen.length === ordered.length ? ' (all)' : ` (every ${Math.floor(ordered.length / sample)}th)`}\n`,
  );
  stdout.write(`      confirmed-false ${wrong.length}\n`);
  stdout.write(`      ambiguous       ${unclear.length}\n`);
  stdout.write(`      FALSE RATE      ${rate.toFixed(1)}%\n`);
  for (const item of wrong.slice(0, 10)) {
    stdout.write(`        ✗ ${item.subject}\n`);
    for (const line of item.evidence.slice(0, 3)) stdout.write(`            ${line}\n`);
  }
  stdout.write('\n');
}

/**
 * Every verdict with its evidence, written to `--out`. Nothing checks that the path lies
 * outside the target repository.
 */
async function writeDetail(out: string, items: readonly ItemVerdict[]): Promise<void> {
  const lines = ['# §5.1(j) — every unreferenced-asset verdict', ''];
  for (const item of [...items].sort((a, b) => (a.subject < b.subject ? -1 : 1))) {
    lines.push(`## ${item.subject} — ${item.kind} — **${item.verdict}**`);
    for (const line of item.evidence) lines.push(`    ${line}`);
    lines.push('');
  }
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${lines.join('\n')}\n`, 'utf8');
  stdout.write(`  detail written to ${out}\n`);
}

await main();
