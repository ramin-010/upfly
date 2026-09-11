/**
 * §5.1(j): the measured false-`dead` rate.
 *
 * **Why this exists.** The Phase 1 exit criterion is *zero false `broken`*, and R26 proved
 * that is necessary without being sufficient. A false `broken` wastes five minutes; a
 * false `dead` says *"safe to remove"* about a file serving on somebody's live site. On a
 * repository outside §5.1(c) the `dead` error rate was **16%**, and §5.1 saw nothing —
 * because it never measured that direction at all. A gate that cannot see the worse
 * failure is not a complete gate.
 *
 * So this reports a **number**, not a pass or a fail: sample N `dead` findings, verify each
 * with the independent oracle, and print the rate. `validate.ts` already runs the same
 * oracle over the three pinned repos; what this adds is the ability to point it at an
 * arbitrary repository — including a private one — and the rate itself as the output.
 *
 * ⚠️ **Read-only, and that is not incidental.** It is expected to be pointed at somebody's
 * working repository. It runs the audit path only, never `--apply`, writes nothing inside
 * the target, and touches no config there. The v2 extension's destructive
 * `upfly.config.json` exists armed in at least one such repo; this must never become a
 * reason to edit one.
 *
 * Usage:
 *
 * ```
 * pnpm --filter upfly-bench run dead-rate -- --root=D:/path/to/repo --public=public
 * pnpm --filter upfly-bench run dead-rate -- --root=… --sample=50 --out=/tmp/detail.md
 * ```
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
 * Progress, written synchronously to stderr and to an optional log.
 *
 * ⚠️ Piped stdout is fully buffered, so the first version of this printed nothing for ten
 * minutes and was indistinguishable from a hang — which is how a long check quietly stops
 * being run at all.
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
    publicDirs: options.publicDirs,
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
 * The rate, and the sample it came from.
 *
 * ⚠️ Deterministic sampling — every Nth item over the sorted list, never `Math.random()`.
 * A rate nobody else can reproduce is an anecdote.
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

/** Per-item detail, written wherever the caller asked — never inside the target repo. */
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
