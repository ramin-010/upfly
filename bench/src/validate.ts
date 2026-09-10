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
import { basename, join, relative } from 'node:path';
import { argv, stdout } from 'node:process';
import {
  type Adapter,
  type Graph,
  IMAGE_EXTENSIONS,
  type Reference,
  type Report,
  audit,
  buildGraph,
  buildReport,
  createSharpProbe,
  cssAdapter,
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
  /** Where a root-relative `/hero.png` is served from. */
  readonly publicDir: string;
}

const REPOS: readonly RepoSpec[] = [
  { name: 'astro-docs', sha: 'cf14d7dd900c261c5c55079fca5e878945c9a96d', publicDir: 'public' },
  { name: 'eleventy-docs', sha: '028e2555848ea8a08ece1ce268ee7d1335271427', publicDir: 'src' },
  {
    name: 'shadcn-ui',
    sha: '3ba91b1cc83e1bbe4ab35a422ff2a694849c5048',
    publicDir: 'apps/www/public',
  },
];

/** A grep hit the graph did not link — the raw material of §5.1(b). */
interface Unaccounted {
  readonly asset: string;
  readonly file: string;
  readonly line: number;
  readonly text: string;
  /** Why it is probably fine, or `null` when it genuinely needs a human. */
  readonly explanation: string | null;
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
  readonly unaccounted: Unaccounted[];
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

async function validateRepo(repo: RepoSpec): Promise<RepoResult> {
  const root = join(VALIDATION_ROOT, repo.name);
  const readFileText = (path: string) => readFile(path, 'utf8');

  const started = performance.now();
  const discovery = await discover({ root, adapters: ADAPTERS });
  const scanned = await scanSources({
    sourceFiles: discovery.sourceFiles,
    adapters: ADAPTERS,
    readFile: readFileText,
  });
  const references = resolveReferences(scanned.references, {
    root: discovery.root,
    assets: discovery.assets,
    publicDir: repo.publicDir,
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

  // --- (a) the range invariant, over real code -----------------------------------
  const { checked, failures } = await checkRanges(scanned.references, readFileText);

  // --- the audit and report, which (c) and (d) are reviews of ---------------------
  const sweep = await sweepForMentions({ graph, readFile: readFileText });
  const probes = await probeAssets(
    graph.assets.map((node) => node.asset),
    { probe: await createSharpProbe(), formats: ['webp'], maxEncodedAssets: 100 },
  );
  const auditResult = await audit({
    graph,
    sweep,
    readFile: readFileText,
    publicDir: repo.publicDir,
    probes,
  });
  const report = buildReport({ graph, audit: auditResult, discovery, sweep, probes });

  // --- (f) determinism ------------------------------------------------------------
  const second = buildReport({ graph, audit: auditResult, discovery, sweep, probes });
  const deterministic = JSON.stringify(second) === JSON.stringify(report);
  const cwdIndependent = !JSON.stringify(report).includes(root.replaceAll('\\', '/'));

  // --- (b) the false-negative sweep -----------------------------------------------
  const unaccounted = await falseNegativeSweep(root, graph, references);

  return {
    repo,
    files: discovery.sourceFiles.length + discovery.assets.length + discovery.unscannedFiles.length,
    assets: discovery.assets.length,
    references: references.length,
    rangeInvariantChecked: checked,
    rangeInvariantFailures: failures,
    graphMs,
    deterministic,
    cwdIndependent,
    unaccounted,
    report,
    human: renderReport(report),
  };
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
 * Deliberately not a summary. The protocol says a human opens every `broken`
 * finding and greps every dead asset before believing it, so this gives one line
 * per thing to check and the exact command to check it with.
 */
function worksheet(result: RepoResult): string {
  const { repo, report } = result;
  const root = `${VALIDATION_ROOT}/${repo.name}`;
  const broken = report.findings.filter((finding) => finding.kind === 'broken');
  const dead = report.findings.filter((finding) => finding.kind === 'dead');
  const hedged = report.findings.filter((finding) => finding.kind === 'possibly-dead');
  const needsHuman = result.unaccounted.filter((entry) => entry.explanation === null);

  const lines = [
    `# ${repo.name} — §5.1(c)/(d) review worksheet`,
    '',
    `Repo \`${repo.name}\` at \`${repo.sha}\`.`,
    `Root: \`${root}\``,
    '',
    '**One false `broken` fails the gate.** Open every one below and confirm the path really',
    'points at nothing. Grep every dead asset before believing it.',
    '',
    '---',
    '',
    `## 1. Broken references — ${broken.length} to open`,
    '',
  ];

  if (broken.length === 0) {
    lines.push('_None reported._', '');
  } else {
    for (const finding of broken) {
      if (finding.kind !== 'broken') continue;
      lines.push(
        `- [ ] \`${finding.where}\` → \`${finding.rawPath}\``,
        '      ```sh',
        `      sed -n '${Math.max(1, (finding.line ?? 1) - 2)},${(finding.line ?? 1) + 2}p' "${root}/${finding.file}"`,
        `      ls -la "${root}/$(dirname "${finding.file}")/${finding.rawPath}" 2>/dev/null || echo "does not exist"`,
        '      ```',
      );
    }
    lines.push('');
  }

  lines.push(`## 2. Dead assets — ${dead.length} to grep`, '');
  if (dead.length === 0) {
    lines.push('_None reported._', '');
  } else {
    for (const finding of dead) {
      if (finding.kind !== 'dead') continue;
      lines.push(
        `- [ ] \`${finding.asset}\`${finding.inPublicDir ? '  *(under the public dir)*' : ''}`,
        '      ```sh',
        `      grep -rn --binary-files=without-match "${basename(finding.asset)}" "${root}" \\`,
        '        --exclude-dir=.git --exclude-dir=node_modules | head',
        '      ```',
      );
    }
    lines.push('');
  }

  lines.push(
    `## 3. Possibly-dead — ${hedged.length} hedged, with the evidence already cited`,
    '',
    'These are *not* claims that the asset is unused. Each names where its filename appears',
    'in something Upfly could not read. Spot-check a few: the citation should be real.',
    '',
  );
  for (const finding of hedged.slice(0, 25)) {
    if (finding.kind !== 'possibly-dead') continue;
    lines.push(
      `- \`${finding.asset}\` — named in ${finding.evidence.map((m) => m.where).join(', ')}`,
    );
  }
  if (hedged.length > 25) lines.push(`- …and ${hedged.length - 25} more, in the JSON report.`);
  lines.push('');

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

function summarise(result: RepoResult): string {
  const counts = result.report.summary.findings;
  const needsHuman = result.unaccounted.filter((entry) => entry.explanation === null).length;

  return [
    `  files ${result.files}, assets ${result.assets}, references ${result.references}`,
    `  (a) range invariant: ${result.rangeInvariantChecked} checked, ${result.rangeInvariantFailures.length} failures`,
    `  (b) unaccounted grep hits: ${result.unaccounted.length} total, ${needsHuman} need a human`,
    `  (f) deterministic: ${result.deterministic}, cwd-independent: ${result.cwdIndependent}`,
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
    '| repo | files | assets | refs | (a) checked | (a) fail | (b) need human | (f) det. | (f) no abs path | (g) graph ms |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];

  for (const result of results) {
    const needsHuman = result.unaccounted.filter((entry) => entry.explanation === null).length;
    lines.push(
      `| ${result.repo.name} | ${result.files} | ${result.assets} | ${result.references} | ${result.rangeInvariantChecked} | ${result.rangeInvariantFailures.length} | ${needsHuman} | ${result.deterministic ? 'yes' : 'NO'} | ${result.cwdIndependent ? 'yes' : 'NO'} | ${result.graphMs} |`,
    );
  }

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
