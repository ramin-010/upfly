/**
 * The §5.1 validation protocol, run against real repositories nobody designed the
 * engine for.
 *
 * Everything above this file is unit-tested in isolation. This is the part that
 * decides whether the engine is *right*, and the parts it can automate are (a),
 * (b), (f) and (g). Parts (c) and (d) need a person — every broken finding opened,
 * every dead asset grepped — so this writes a worksheet rather than a verdict.
 *
 * The repositories live **outside the workspace** with a kill-switch config, because
 * all three contain image directories and the v2 extension converts what it finds in
 * one, in place, deleting the original. It did that to 19 fixture images. Cloned
 * inside the workspace it would invalidate the entire validation while the numbers
 * still looked plausible.
 */

import type { Dirent } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { argv, chdir, cwd, stdout } from 'node:process';
import {
  type Adapter,
  type Asset,
  type Graph,
  IMAGE_EXTENSIONS,
  type Reference,
  type Report,
  audit,
  buildGraph,
  buildReport,
  createSharpProbe,
  cssAdapter,
  detectConventionRoots,
  discover,
  htmlAdapter,
  javascriptAdapter,
  jsonAdapter,
  linkedPaths,
  markdownAdapter,
  probeAssets,
  renderReport,
  resolveReferences,
  scanSources,
  sweepForMentions,
} from 'upfly-core';
import { type ItemVerdict, type VerifyResult, verifyFindings } from './verify.js';

const ADAPTERS: readonly Adapter[] = [
  cssAdapter,
  htmlAdapter,
  javascriptAdapter,
  markdownAdapter,
  jsonAdapter,
];

const VALIDATION_ROOT = 'E:/PERSONAL_PROJECTS/upfly-validation';

interface RepoSpec {
  readonly name: string;
  readonly sha: string;
  /**
   * Every directory a root-relative `/hero.png` may be served from.
   *
   * A list because a monorepo has one per app — shadcn-ui has six, and resolving
   * against a single one produced 93 false `broken` findings (R13).
   */
  readonly publicDirs: readonly string[];
}

const REPOS: readonly RepoSpec[] = [
  { name: 'astro-docs', sha: 'cf14d7dd900c261c5c55079fca5e878945c9a96d', publicDirs: ['public'] },
  { name: 'eleventy-docs', sha: '028e2555848ea8a08ece1ce268ee7d1335271427', publicDirs: ['src'] },
  {
    name: 'shadcn-ui',
    sha: '3ba91b1cc83e1bbe4ab35a422ff2a694849c5048',
    // Every `public/` in the workspace, as auto-detection would find them. There
    // are twelve, not the six a `-maxdepth 3` search turns up — the fixture apps
    // under `packages/` have their own, and leaving those out reports their
    // references broken.
    publicDirs: [
      'apps/v4/public',
      'packages/shadcn/test/fixtures/frameworks/remix-indie-stack/public',
      'packages/shadcn/test/fixtures/frameworks/remix/public',
      'packages/shadcn/test/fixtures/frameworks/vite/public',
      'packages/shadcn/test/fixtures/vite-with-tailwind/public',
      'templates/astro-app/public',
      'templates/astro-monorepo/apps/web/public',
      'templates/next-app/public',
      'templates/react-router-app/public',
      'templates/start-app/public',
      'templates/start-monorepo/apps/web/public',
      'templates/vite-app/public',
    ],
  },
];

/** Lowercased asset basenames, for the mention pass `scan` does while reading. */
function basenamesOf(assets: readonly Asset[]): Set<string> {
  return new Set(
    assets.map((asset) => asset.relative.slice(asset.relative.lastIndexOf('/') + 1).toLowerCase()),
  );
}

/** A grep hit the graph did not link — the raw material of §5.1(b). */
interface Unaccounted {
  readonly asset: string;
  readonly file: string;
  readonly line: number;
  readonly text: string;
  /** Why it is probably fine, or `null` when it genuinely needs a human. */
  readonly explanation: string | null;
}

/** One complete pass over a repository, from the walk to the rendered report. */
interface PipelineResult {
  readonly discovery: Awaited<ReturnType<typeof discover>>;
  readonly scanned: Awaited<ReturnType<typeof scanSources>>;
  readonly references: readonly Reference[];
  readonly graph: Graph;
  readonly report: Report;
  readonly human: string;
  readonly graphMs: number;
}

interface RepoResult {
  readonly repo: RepoSpec;
  readonly files: number;
  readonly assets: number;
  readonly references: number;
  readonly rangeInvariantChecked: number;
  readonly rangeInvariantFailures: { file: string; rawPath: string; sliced: string }[];
  readonly graphMs: number;
  readonly deterministic: boolean;
  readonly cwdIndependent: boolean;
  readonly noAbsolutePath: boolean;
  /** Whatever proved the absolute-path check wrong, so a failure names itself. */
  readonly absolutePathEvidence: string[];
  readonly unaccounted: Unaccounted[];
  /** §5.1(d), the automated half: a verdict per finding, from an independent oracle. */
  readonly verified: VerifyResult;
  readonly report: Report;
  readonly human: string;
}

async function main(): Promise<void> {
  const only = argv.find((argument) => argument.startsWith('--repo='))?.slice('--repo='.length);
  const outDir = join(VALIDATION_ROOT, '..', 'upfly', 'notes', 'validation');
  await mkdir(outDir, { recursive: true });

  const results: RepoResult[] = [];
  for (const repo of REPOS) {
    if (only !== undefined && repo.name !== only) continue;
    stdout.write(`\n=== ${repo.name} ===\n`);
    const result = await validateRepo(repo);
    results.push(result);
    await writeArtifacts(outDir, result);
    stdout.write(summarise(result));
  }

  await writeFile(join(outDir, 'SUMMARY.md'), overallSummary(results), 'utf8');
  stdout.write(`\nWrote worksheets to ${outDir}\n`);
}

/**
 * Every stage, run for real, from a cold start.
 *
 * It is a function rather than inline code because §5.1(f) asks whether *two runs*
 * agree, and the first version of this file answered that by calling `buildReport`
 * twice on one set of in-memory objects. That proves `buildReport` is pure and
 * nothing else: with `Math.random()` sorting the references it still reported
 * `deterministic: true` while the written JSON differed by 318 lines. Determinism
 * has to be measured over the whole pipeline or it is not measured at all.
 */
async function runPipeline(repo: RepoSpec): Promise<PipelineResult> {
  const root = join(VALIDATION_ROOT, repo.name);
  const readFileText = (path: string) => readFile(path, 'utf8');

  const started = performance.now();
  const discovery = await discover({ root, adapters: ADAPTERS });
  const scanned = await scanSources({
    sourceFiles: discovery.sourceFiles,
    adapters: ADAPTERS,
    readFile: readFileText,
    assetBasenames: basenamesOf(discovery.assets),
  });
  const references = resolveReferences(scanned.references, {
    root: discovery.root,
    assets: discovery.assets,
    publicDirs: repo.publicDirs,
    excludedRoots: discovery.excludedRoots,
    exists: (path) => existsSync(path),
  });
  const graph = buildGraph({
    root: discovery.root,
    assets: discovery.assets,
    references,
    unscannedFiles: [...discovery.unscannedFiles, ...scanned.unscanned],
  });
  const graphMs = Math.round(performance.now() - started);

  // --- the audit and report, which (c) and (d) are reviews of ---------------------
  const sweep = await sweepForMentions({
    graph,
    readFile: readFileText,
    // Haystack (c): only read if the cheaper two leave something unexplained.
    scannedMentions: scanned.mentions,
    publicDirs: repo.publicDirs,
  });
  const probes = await probeAssets(
    graph.assets.map((node) => node.asset),
    { probe: await createSharpProbe(), formats: ['webp'], maxEncodedAssets: 100 },
  );
  // R17: which directories a framework reads certain filenames from. Derived from
  // the file list `discover` already produced, so no extra walk and no disk access
  // in `audit` — `next.config.mjs` is claimed by the JavaScript adapter, so it is
  // already a source file by the time this runs.
  const conventionRoots = detectConventionRoots([
    ...discovery.sourceFiles.map((file) => file.relative),
    ...discovery.unscannedFiles.map((file) => file.relative),
  ]);

  const auditResult = await audit({
    graph,
    conventionRoots,
    sweep,
    readFile: readFileText,
    publicDirs: repo.publicDirs,
    probes,
  });
  const report = buildReport({ graph, audit: auditResult, discovery, sweep, probes });

  return { discovery, scanned, references, graph, report, human: renderReport(report), graphMs };
}

async function validateRepo(repo: RepoSpec): Promise<RepoResult> {
  const root = join(VALIDATION_ROOT, repo.name);
  const readFileText = (path: string) => readFile(path, 'utf8');

  const first = await runPipeline(repo);

  // --- (a) the range invariant, over real code -----------------------------------
  const { checked, failures } = await checkRanges(first.scanned.references, readFileText);

  // --- (f) determinism: two whole runs, byte for byte ------------------------------
  const second = await runPipeline(repo);
  const deterministic = JSON.stringify(second.report) === JSON.stringify(first.report);

  // --- (f) and a third run from a different working directory ----------------------
  // §5.1(f) asks for this by name. `Reference.file` is absolute and four upstream
  // types carry an absolute path beside their relative one, so a cwd the output
  // depends on is a real risk rather than a theoretical one.
  const originalCwd = cwd();
  chdir(tmpdir());
  const elsewhere = await runPipeline(repo);
  chdir(originalCwd);
  const cwdIndependent = JSON.stringify(elsewhere.report) === JSON.stringify(first.report);

  // --- (f) and no absolute path in the output at all -------------------------------
  const { clean: noAbsolutePath, evidence: absolutePathEvidence } = checkNoAbsolutePath(
    first.report,
    first.human,
    root,
  );

  // --- (b) the false-negative sweep -----------------------------------------------
  const unaccounted = await falseNegativeSweep(root, first.graph, first.references);

  // --- (d) every broken opened, every dead grepped, by something that is not us ----
  const verified = await verifyFindings(root, first.report, repo.publicDirs);

  return {
    repo,
    files:
      first.discovery.sourceFiles.length +
      first.discovery.assets.length +
      first.discovery.unscannedFiles.length,
    assets: first.discovery.assets.length,
    references: first.references.length,
    rangeInvariantChecked: checked,
    rangeInvariantFailures: failures,
    graphMs: first.graphMs,
    deterministic,
    cwdIndependent,
    noAbsolutePath,
    absolutePathEvidence,
    unaccounted,
    verified,
    report: first.report,
    human: first.human,
  };
}

/**
 * §5.1(f): no absolute path reaches the output.
 *
 * The first version searched the serialised JSON for the root spelled with forward
 * slashes. `JSON.stringify` escapes a native Windows path to `E:\\PERSONAL…`, so
 * that needle could not match the one spelling the leak actually takes: with 81
 * absolute paths deliberately leaked into the report it still answered "clean".
 *
 * So this checks what `report.test.ts` checks on the fixtures — an escaped
 * backslash, or a drive letter — plus the root in both spellings, and it returns
 * what it found so a failure names itself instead of being one boolean.
 */
function checkNoAbsolutePath(
  report: Report,
  human: string,
  root: string,
): { clean: boolean; evidence: string[] } {
  const serialised = JSON.stringify(report);
  const evidence: string[] = [];

  const nativeRoot = JSON.stringify(root).slice(1, -1);
  if (serialised.includes(nativeRoot)) evidence.push(`JSON contains the root: ${nativeRoot}`);

  const posixRoot = root.replaceAll('\\', '/');
  if (serialised.includes(posixRoot)) evidence.push(`JSON contains the POSIX root: ${posixRoot}`);

  // A Windows absolute path, which always opens with a drive letter or a UNC pair.
  //
  // ⚠️ NOT "any string containing a backslash", which is what this checked first and
  // what `report.test.ts` still checks on the fixtures. On `shadcn-ui` that fired on a
  // raw path the engine reported exactly as its author wrote it, in a CSS-in-JS
  // template — the engine being right. The property is *no absolute path*, and a lone
  // backslash is not evidence of one. It survives on the fixtures only because no
  // fixture source contains a backslash.
  const windowsAbsolute = serialised.match(/[A-Za-z]:\\\\/)?.[0];
  if (windowsAbsolute !== undefined) {
    evidence.push(`JSON has a Windows absolute path: ${windowsAbsolute}`);
  }

  // A drive letter must not be preceded by another letter, or every `https://` in a
  // documentation repository matches on the `s:/`. `report.test.ts` uses the looser
  // form and passes only because no fixture report contains a URL.
  const drive = serialised.match(/(?:^|[^A-Za-z])[A-Za-z]:\//)?.[0];
  if (drive !== undefined) evidence.push(`JSON has a drive letter: ${drive}`);

  if (human.includes(root) || human.includes(posixRoot)) {
    evidence.push('the human report contains the root');
  }

  return { clean: evidence.length === 0, evidence };
}

/**
 * §5.1(a): `source.slice(start, end) === rawPath`, for every reference.
 *
 * One cheap invariant that kills the whole class of offset bugs — the class that
 * silently corrupts a file at rewrite time and is invisible any other way.
 */
async function checkRanges(
  references: readonly { file: string; start: number; end: number; rawPath: string }[],
  readFileText: (path: string) => Promise<string>,
): Promise<{ checked: number; failures: { file: string; rawPath: string; sliced: string }[] }> {
  const byFile = new Map<string, typeof references>();
  for (const reference of references) {
    byFile.set(reference.file, [...(byFile.get(reference.file) ?? []), reference]);
  }

  const failures: { file: string; rawPath: string; sliced: string }[] = [];
  let checked = 0;

  for (const [file, group] of byFile) {
    const text = await readFileText(file);
    for (const reference of group) {
      checked += 1;
      const sliced = text.slice(reference.start, reference.end);
      if (sliced !== reference.rawPath) {
        failures.push({ file, rawPath: reference.rawPath, sliced });
      }
    }
  }

  return { checked, failures };
}

/**
 * §5.1(b): the missing half.
 *
 * Every ruling so far targets false *positives*. A false negative is worse: a
 * reference the adapters miss looks clean in the audit, then the rewrite changes the
 * image without updating it and the build breaks with nothing reported.
 *
 * So: grep the whole repository for every asset's filename, and account for every
 * hit the graph did not link. Each one is either a genuine miss — fix the adapter,
 * add the fixture — or correctly out of scope, and this writes down which so a
 * person only has to look at the ones that are neither.
 */
async function falseNegativeSweep(
  root: string,
  graph: Graph,
  references: readonly Reference[],
): Promise<Unaccounted[]> {
  const assetsByBasename = new Map<string, string[]>();
  for (const node of graph.assets) {
    const key = basename(node.asset.relative).toLowerCase();
    assetsByBasename.set(key, [...(assetsByBasename.get(key) ?? []), node.asset.relative]);
  }

  // Which (file, asset) pairs the graph already knows about.
  const linked = new Set<string>();
  for (const reference of references) {
    for (const target of linkedPaths(reference)) {
      linked.add(`${reference.file}\u0000${target}`);
    }
  }

  const claimed = new Set(ADAPTERS.flatMap((adapter) => [...adapter.extensions]));
  const unaccounted: Unaccounted[] = [];
  const pattern = new RegExp(
    `[\\w@.\\-]+\\.(?:${IMAGE_EXTENSIONS.map((extension) => extension.slice(1)).join('|')})\\b`,
    'gi',
  );

  for await (const file of walk(root)) {
    const extension = file.slice(file.lastIndexOf('.')).toLowerCase();
    if (IMAGE_EXTENSIONS.includes(extension)) continue;

    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    if (text.length > 2_000_000) continue;

    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match !== null) {
      const token = match[0].toLowerCase();
      for (const asset of assetsByBasename.get(token) ?? []) {
        const absolute = join(root, asset.replaceAll('/', '\\'));
        if (linked.has(`${absolute}\u0000${absolute}`)) continue;
        if (linked.has(`${file}\u0000${absolute}`)) continue;

        const line = lineText(text, match.index);
        unaccounted.push({
          asset,
          file: relative(root, file).replaceAll('\\', '/'),
          line: lineOf(text, match.index),
          text: line,
          explanation: explain(extension, claimed, line, match[0]),
        });
      }
      match = pattern.exec(text);
    }
  }

  return unaccounted.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.asset.localeCompare(b.asset),
  );
}

/**
 * Why a hit is probably fine, or `null` when a person has to decide.
 *
 * Only the `null` ones are real §5.1(b) work. Everything else is a known gap that
 * `possibly-dead` already covers, or a file kind that was never a candidate.
 */
function explain(
  extension: string,
  claimed: ReadonlySet<string>,
  line: string,
  token: string,
): string | null {
  if (!claimed.has(extension)) {
    return `no adapter reads ${extension} — covered by unscannedExtensions and possibly-dead`;
  }

  // An absolute URL is not a reference to a file in this repository. Documentation
  // repos are full of them — astro-docs cites its own published assets by URL — and
  // leaving them in buries the hits that actually need a decision.
  const before = line.slice(0, Math.max(0, line.indexOf(token)));
  if (/https?:\/\/\S*$/.test(before)) {
    return 'part of an absolute URL, which was never a candidate reference';
  }

  // A documentation example rather than a live reference: an import statement being
  // shown to a reader, or a fenced snippet of what to type.
  if (
    (extension === '.md' || extension === '.mdx') &&
    /^\s*(?:import\b|<|\||\$|npm\b|npx\b|pnpm\b|#)/.test(line)
  ) {
    return 'inside a documentation example, not a live reference';
  }

  return null;
}

async function* walk(directory: string): AsyncGenerator<string> {
  const skip = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.astro', 'coverage']);
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!skip.has(entry.name)) yield* walk(path);
    } else if (entry.isFile()) {
      yield path;
    }
  }
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index++) {
    if (text[index] === '\n') line += 1;
  }
  return line;
}

function lineText(text: string, offset: number): string {
  const start = text.lastIndexOf('\n', offset) + 1;
  const end = text.indexOf('\n', offset);
  return text
    .slice(start, end === -1 ? undefined : end)
    .trim()
    .slice(0, 160);
}

/** Per-repo artefacts: the report, and the worksheet (c) and (d) are worked through. */
async function writeArtifacts(outDir: string, result: RepoResult): Promise<void> {
  const name = result.repo.name;
  await writeFile(
    join(outDir, `${name}.report.json`),
    `${JSON.stringify(result.report, null, 2)}\n`,
    'utf8',
  );
  await writeFile(join(outDir, `${name}.report.txt`), result.human, 'utf8');
  await writeFile(join(outDir, `${name}.review.md`), worksheet(result), 'utf8');
}

/**
 * The worksheet for §5.1(c) and (d).
 *
 * Deliberately not a summary, and no longer a list of commands either. §5.1(d) was
 * amended because the first version of this file produced **601 checkboxes with the
 * grep already written out** — so `verify.ts` runs them and this reports the
 * verdicts, expanding only what a person actually has to decide.
 */
function worksheet(result: RepoResult): string {
  const { repo } = result;
  const root = `${VALIDATION_ROOT}/${repo.name}`;
  const needsHuman = result.unaccounted.filter((entry) => entry.explanation === null);

  const lines = [
    `# ${repo.name} — §5.1(c)/(d) review worksheet`,
    '',
    `Repo \`${repo.name}\` at \`${repo.sha}\`.`,
    `Root: \`${root}\``,
    '',
    'Every `broken` finding has been opened and every `dead` asset grepped **by machine**, against',
    'an oracle that does not use the engine — its own directory index and its own grep, over the',
    `whole tree including pruned and ignored directories. ${verdictHeadline(result.verified)}`,
    '',
    '**What is left for you is below: the ambiguous items and the judgement calls.** A verdict of',
    '*confirmed-genuine* means the oracle looked and found nothing; spot-check a few rather than',
    'reproducing them.',
    '',
    '---',
    '',
  ];

  lines.push(...verdictSection('broken', '1. Broken references', result.verified));
  lines.push(...verdictSection('dead', '2. Dead assets', result.verified));
  lines.push(...verdictSection('possibly-dead', '3. Possibly-dead citations', result.verified));

  lines.push(
    `## 4. §5.1(b) false-negative sweep — ${needsHuman.length} hits need a decision`,
    '',
    `Grepped the whole repo for every asset filename. ${result.unaccounted.length} hits were not`,
    `linked by the graph; ${result.unaccounted.length - needsHuman.length} are in file types no`,
    'adapter reads, which `possibly-dead` already covers. The rest are below: each is either a',
    'genuine adapter miss (fix it, add a fixture) or correctly out of scope (write down which).',
    '',
  );
  if (needsHuman.length === 0) {
    lines.push('_Nothing unaccounted for in a file an adapter claims._', '');
  } else {
    for (const entry of needsHuman.slice(0, 60)) {
      lines.push(
        `- [ ] \`${entry.file}:${entry.line}\` mentions \`${entry.asset}\``,
        `      \`${entry.text}\``,
      );
    }
    if (needsHuman.length > 60) lines.push(`- …and ${needsHuman.length - 60} more.`);
    lines.push('');
  }

  lines.push(
    '## 5. Read the report as a stranger',
    '',
    `\`${repo.name}.report.txt\` is the human output. §5.1(d): if the numbers are not obvious in`,
    'ten seconds, or the skipped list reads as noise, the report has failed even with a correct',
    'graph behind it.',
    '',
  );

  return `${lines.join('\n')}\n`;
}

/** One line saying whether anything failed the gate, before any detail. */
function verdictHeadline(verified: VerifyResult): string {
  const wrong = verified.items.filter((item) => item.verdict === 'confirmed-false').length;
  const unclear = verified.items.filter((item) => item.verdict === 'ambiguous').length;

  const headline =
    wrong > 0
      ? `**${wrong} finding(s) came back confirmed-false — the gate is not passed.**`
      : unclear === 0
        ? `All ${verified.items.length} came back confirmed-genuine.`
        : `None came back false; ${unclear} are ambiguous and need you.`;

  return `${headline}\n\n${BLIND_SPOT}`;
}

/**
 * What the oracle structurally cannot see, stated next to its verdicts.
 *
 * §5.1(d), amended: **independent in implementation is not independent in
 * assumption.** This oracle walks a different tree with a different regex and never
 * touches the engine's resolver — and it still confirmed a false `dead` as genuine,
 * because the engine and the oracle are both *string searchers*. R17 was found by a
 * person reading the output, not by the machine that had just run over it.
 *
 * A "0 confirmed-false" that does not say what it cannot see is the same overclaim
 * as a check that cannot fail, which is what §5.1(f) turned out to be.
 */
const BLIND_SPOT = [
  '> ⚠️ **What this pass cannot see.** Every check above searches for a *string*. An asset that is',
  '> alive with **no string naming it anywhere** is invisible to it exactly as it is invisible to the',
  '> engine — a framework file convention (R17 was found this way, and this oracle confirmed one of',
  '> the two as genuine), a build-config glob, a CMS, a filename assembled at runtime from data.',
  '> So "0 confirmed-false" bounds the machine\'s reach, not the truth.',
  '>',
  '> **The question only a person can carry:** *is anything here alive for a reason that is not a',
  '> string?*',
].join('\n');

/**
 * One finding kind, ordered by how much attention it needs.
 *
 * `confirmed-false` first because one of those fails the gate, then `ambiguous`
 * because those are the actual work, then `confirmed-genuine` collapsed to a list —
 * expanding 120 items a machine already checked is how a worksheet becomes 601
 * checkboxes nobody reads.
 */
function verdictSection(
  kind: ItemVerdict['kind'],
  title: string,
  verified: VerifyResult,
): string[] {
  const items = verified.items.filter((item) => item.kind === kind);
  const lines = [`## ${title} — ${items.length}`, ''];

  if (items.length === 0) {
    lines.push('_None reported._', '');
    return lines;
  }

  for (const verdict of ['confirmed-false', 'ambiguous'] as const) {
    const group = items.filter((item) => item.verdict === verdict);
    if (group.length === 0) continue;

    lines.push(
      verdict === 'confirmed-false'
        ? `### ⚠️ ${group.length} confirmed FALSE — the oracle disagrees with the engine`
        : `### ${group.length} ambiguous — your call`,
      '',
    );
    // Same `group` means same decision. Rendering it once is the difference between
    // three judgement calls and twenty identical checkboxes.
    const buckets = new Map<string, typeof group>();
    for (const item of group) {
      const key = item.group ?? item.subject;
      buckets.set(key, [...(buckets.get(key) ?? []), item]);
    }

    for (const [key, bucket] of buckets) {
      const first = bucket[0];
      if (first === undefined) continue;

      if (bucket.length === 1) {
        lines.push(`- [ ] \`${first.subject}\``);
        for (const line of first.evidence) lines.push(`      ${line}`);
        continue;
      }

      lines.push(`- [ ] \`${key}\` — ${bucket.length} references, one decision`);
      for (const line of first.evidence) lines.push(`      ${line}`);
      lines.push('', '      Affected:');
      for (const item of bucket) lines.push(`        ${item.subject.split(' \u2192 ')[0] ?? ''}`);
    }
    lines.push('');
  }

  const genuine = items.filter((item) => item.verdict === 'confirmed-genuine');
  if (genuine.length > 0) {
    lines.push(
      `### ${genuine.length} confirmed genuine — checked, nothing found`,
      '',
      'Spot-check two or three against the method rather than repeating the check.',
      '',
    );
    for (const item of genuine.slice(0, 15)) lines.push(`- \`${item.subject}\``);
    if (genuine.length > 15) lines.push(`- …and ${genuine.length - 15} more.`);
    lines.push('');
  }

  return lines;
}

/** Verdict tallies, so a false finding is visible without opening the worksheet. */
function verdictCounts(verified: VerifyResult): string {
  const of = (verdict: ItemVerdict['verdict']) =>
    verified.items.filter((item) => item.verdict === verdict).length;

  return `${of('confirmed-genuine')} genuine, ${of('confirmed-false')} FALSE, ${of('ambiguous')} ambiguous`;
}

function summarise(result: RepoResult): string {
  const counts = result.report.summary.findings;
  const needsHuman = result.unaccounted.filter((entry) => entry.explanation === null).length;

  return [
    `  files ${result.files}, assets ${result.assets}, references ${result.references}`,
    `  (a) range invariant: ${result.rangeInvariantChecked} checked, ${result.rangeInvariantFailures.length} failures`,
    `  (b) unaccounted grep hits: ${result.unaccounted.length} total, ${needsHuman} need a human`,
    `  (f) deterministic: ${result.deterministic}, cwd-independent: ${result.cwdIndependent}, no absolute path: ${result.noAbsolutePath}`,
    ...(result.absolutePathEvidence.length === 0
      ? []
      : result.absolutePathEvidence.map((line) => `      ! ${line}`)),
    `  (d) verdicts: ${verdictCounts(result.verified)}  (oracle indexed ${result.verified.filesIndexed}, grepped ${result.verified.filesGrepped})`,
    `  (g) graph: ${result.graphMs} ms`,
    `  findings: broken ${counts.broken}, dead ${counts.dead}, possibly-dead ${counts['possibly-dead']}, oversized ${counts.oversized}, opportunities ${counts['format-opportunity']}`,
    '',
  ].join('\n');
}

function overallSummary(results: readonly RepoResult[]): string {
  const lines = [
    '# §5.1 validation — automated parts',
    '',
    'Produced by `bench/src/validate.ts`. Parts (c) and (d) need a person; see each',
    '`*.review.md` worksheet.',
    '',
    '| repo | files | assets | refs | (a) checked | (a) fail | (b) need human | (f) det. | (f) cwd | (f) no abs path | (g) graph ms |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ];

  for (const result of results) {
    const needsHuman = result.unaccounted.filter((entry) => entry.explanation === null).length;
    lines.push(
      `| ${result.repo.name} | ${result.files} | ${result.assets} | ${result.references} | ${result.rangeInvariantChecked} | ${result.rangeInvariantFailures.length} | ${needsHuman} | ${result.deterministic ? 'yes' : 'NO'} | ${result.cwdIndependent ? 'yes' : 'NO'} | ${result.noAbsolutePath ? 'yes' : 'NO'} | ${result.graphMs} |`,
    );
  }

  lines.push(
    '',
    '⚠️ **What the §5.1(d) verdicts cannot cover.** Every automated check searches for a string.',
    'An asset alive with no string naming it anywhere is invisible to the oracle exactly as it is',
    'invisible to the engine — R17 is one, and the oracle confirmed one of its two instances as',
    '*genuine*. A person still has to ask whether anything here is alive for a reason that is not',
    'a string.',
    '',
  );

  lines.push('', '## Findings per repo', '');
  lines.push('| repo | broken | dead | possibly-dead | oversized | opportunities |');
  lines.push('|---|---|---|---|---|---|');
  for (const result of results) {
    const counts = result.report.summary.findings;
    lines.push(
      `| ${result.repo.name} | ${counts.broken} | ${counts.dead} | ${counts['possibly-dead']} | ${counts.oversized} | ${counts['format-opportunity']} |`,
    );
  }
  lines.push('');

  return `${lines.join('\n')}\n`;
}

await main();
