/**
 * The validation protocol, run against real repositories nobody designed the engine for.
 *
 * Everything else is unit-tested in isolation; this decides whether the engine is right.
 * It automates the checks the summary labels (a), (b), (f) and (g). The review of each
 * finding, (c) and (d), needs a person, so it writes a worksheet rather than a verdict,
 * after `verify.ts` has checked what a machine can.
 *
 * The repositories live outside the workspace with the v2 VS Code extension's kill
 * switch, because that extension converts images in place, deleting the originals.
 */

import type { Dirent } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { argv, chdir, cwd, stdout } from 'node:process';
import {
  type Adapter,
  type DiscoveryResult,
  type Graph,
  IMAGE_EXTENSIONS,
  type PipelineOutput,
  type ProbeDiagnostic,
  type RawReference,
  type Reference,
  type Report,
  type ScanDiagnostic,
  type ServingRoots,
  buildReport,
  decideServingRoots,
  defaultAdapters,
  runPipeline as enginePipeline,
  linkedPaths,
  renderReport,
} from 'upfly-core';
import { REPOS, type RepoSpec, VALIDATION_ROOT, labelOf } from './repos.js';
import { type Triaged, triage } from './triage.js';
import { type ItemVerdict, type VerifyResult, verifyFindings } from './verify.js';

const ADAPTERS: readonly Adapter[] = defaultAdapters;

/** One complete pass over a repository, from the walk to the rendered report. */
interface PipelineResult {
  readonly discovery: PipelineOutput['discovery'];
  readonly scanned: PipelineOutput['scanned'];
  readonly references: readonly Reference[];
  readonly graph: Graph;
  readonly report: Report;
  readonly human: string;
  readonly diagnostics: readonly ProbeDiagnostic[];
  readonly scanDiagnostics: readonly ScanDiagnostic[];
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
  /** Where two runs disagreed, when they did. A bare `false` cannot be acted on. */
  readonly determinismDiff: readonly string[];
  readonly cwdDiff: readonly string[];
  /** `skipped` entries that differed between runs, quoted so a red verdict names itself. */
  readonly environmentNotes: readonly string[];
  readonly cwdIndependent: boolean;
  readonly noAbsolutePath: boolean;
  /** Whatever proved the absolute-path check wrong, so a failure names itself. */
  readonly absolutePathEvidence: string[];
  readonly unaccounted: Triaged[];
  /** The review's automated half: a verdict per finding, from an independent oracle. */
  readonly verified: VerifyResult;
  readonly report: Report;
  readonly human: string;
  /**
   * What libvips said about the files it could not read.
   *
   * Kept out of the report, which is byte-identical for the same input, because libvips
   * words the same failure differently from one read to the next. It is written beside
   * the report, in a file nothing compares, so an unreadable file can still be diagnosed.
   */
  readonly diagnostics: readonly ProbeDiagnostic[];
  /**
   * What PostCSS and Babel said, kept out of the report for the same reason.
   *
   * A message such as `<css input>:144:13: Unknown word /` is in the parser's own terms.
   * The report carries the position and Upfly's own classification; the wording is here.
   */
  readonly scanDiagnostics: readonly ScanDiagnostic[];
}

async function main(): Promise<void> {
  const only = argv.find((argument) => argument.startsWith('--repo='))?.slice('--repo='.length);
  const probed = !argv.includes('--no-probe');
  const outDir = join(VALIDATION_ROOT, '..', 'upfly', 'notes', 'validation');
  await mkdir(outDir, { recursive: true });

  const results: RepoResult[] = [];
  for (const repo of REPOS) {
    if (only !== undefined && repo.name !== only) continue;
    stdout.write(`\n=== ${labelOf(repo)} ===\n`);
    const result = await validateRepo(repo, probed);
    results.push(result);
    await writeArtifacts(outDir, result);
    stdout.write(summarise(result));
  }

  // A partial run must not leave behind something that looks complete. `--repo=` and
  // `--no-probe` each produce results that are true but not the whole validation, and
  // SUMMARY.md is the file numbers get quoted from, so a partial run says so at its top.
  const partial = only !== undefined || !probed;
  await writeFile(
    join(outDir, 'SUMMARY.md'),
    partial ? partialSummary(results, only, probed) : overallSummary(results),
    'utf8',
  );
  stdout.write(`\nWrote worksheets to ${outDir}\n`);
  if (partial) {
    stdout.write('\n⚠️  Partial run. SUMMARY.md says so. Re-run with no flags before quoting it.\n');
  }
}

/**
 * What SUMMARY.md says when the run was not the whole validation.
 *
 * Keeps the table, because the rows that ran are real, and puts the limitation above it
 * rather than in a footnote, because a limitation below the numbers is one nobody reads.
 */
function partialSummary(
  results: readonly RepoResult[],
  only: string | undefined,
  probed: boolean,
): string {
  const absent = REPOS.filter(
    (repo) => !results.some((result) => labelOf(result.repo) === labelOf(repo)),
  );
  const reasons: string[] = [];
  if (only !== undefined) {
    reasons.push(
      `**Only \`${only}\` ran.** Not run: ${absent.map((repo) => repo.name).join(', ') || 'none'}.`,
    );
  }
  if (!probed) {
    reasons.push(
      '**`--no-probe`**, so `oversized` and `format-opportunity` are absent and no saving was measured.',
    );
  }

  return [
    '# ⚠️ PARTIAL RUN — this is not the §5.1 gate',
    '',
    'Everything below was measured and is true. It is simply not all of it.',
    '**Re-run `pnpm validate` with no flags before quoting any of it as a result.**',
    '',
    ...reasons.map((reason) => `- ${reason}`),
    '',
    overallSummary(results),
  ].join('\n');
}

/**
 * The serving roots one run resolves against.
 *
 * A configured entry uses its hand-tuned list, declared. An `unconfigured` entry decides
 * them exactly as a first run does, so the corpus also measures what a stranger meets.
 * Detection and inference reproduce the hand-tuned lists on these repositories, so an
 * unconfigured report mostly repeats its configured twin; what still differs is
 * `declared: false`, which the report words differently.
 */
function servingRootsFor(
  repo: RepoSpec,
  discovery: DiscoveryResult,
  references: readonly RawReference[],
): ServingRoots {
  if (repo.unconfigured !== true) return { dirs: repo.publicDirs, declared: true };

  // The decision the engine's `servingRootsFor` makes when nothing is declared, because
  // what a stranger sees has to come from the code a stranger runs.
  return decideServingRoots({
    root: discovery.root,
    directories: discovery.directories,
    assets: discovery.assets,
    sourceFiles: discovery.sourceFiles,
    unscannedFiles: discovery.unscannedFiles,
    references,
  }).servingRoots;
}

/**
 * One repository, every stage run for real from a cold start, then rendered.
 *
 * A function because determinism is checked over whole runs: calling `buildReport` twice
 * on the same objects only proves `buildReport` pure. The pipeline is the engine's own,
 * the one `optimize` runs, so the numbers here describe the shipped engine.
 *
 * The sweep and the audit get the directories the resolver resolved against, not the
 * table's `publicDirs`, which an unconfigured entry does not use and may leave empty.
 * Told that no directory is served, the audit would mark every dead public asset
 * `inPublicDir: false` and drop the caveat that it may be linked from outside the
 * repository.
 */
async function runPipeline(repo: RepoSpec, probed: boolean): Promise<PipelineResult> {
  const output = await enginePipeline({
    root: join(VALIDATION_ROOT, repo.name),
    servingRoots: (discovery, scanned) => servingRootsFor(repo, discovery, scanned.references),
    publicDirs: (servingRoots) => servingRoots.dirs,
    probeOptions: probed ? { formats: ['webp'], maxEncodedAssets: 100 } : null,
  });

  // `includeUnusedVectors` lists the unreferenced vectors kept out of `findings`, so the
  // oracle can still check them. It changes only whether `unusedVectors.assets` is
  // populated, never a finding or a count, so the determinism comparison and every number
  // in the artefacts are unaffected.
  const report = buildReport({
    graph: output.graph,
    audit: output.audit,
    discovery: output.discovery,
    sweep: output.sweep,
    servingRoots: output.servingRoots,
    ...(output.probes === undefined ? {} : { probes: output.probes }),
    includeUnusedVectors: true,
    // The report names the file this run writes the libraries' own words to. A bare name
    // rather than a path, because the report must read the same from any checkout;
    // `writeArtifacts` puts the file beside the report it belongs to.
    diagnosticsFile: `${labelOf(repo)}.diagnostics.txt`,
  });

  return {
    discovery: output.discovery,
    scanned: output.scanned,
    references: output.references,
    graph: output.graph,
    report,
    human: renderReport(report),
    diagnostics: output.diagnostics,
    scanDiagnostics: output.scanDiagnostics,
    graphMs: output.graphMs,
  };
}

/**
 * Whether two reports are the same, byte for byte: a determinism claim covers all of it.
 *
 * That includes `skipped`. The libraries' wording is kept out of the report, so nothing
 * left in `skipped` is outside Upfly's control, and an entry that appears in one run and
 * not the next is a finding to investigate rather than noise to excuse.
 */
function sameReport(a: Report, b: Report): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Entries that appeared in one run's `skipped` list and not the other's.
 *
 * Quoted in full rather than counted, because "one more skip" is not actionable: naming
 * the entry is what lets a person judge it rather than tolerate it.
 */
function skippedDifferences(a: Report, b: Report): string[] {
  const key = (entry: Report['skipped'][number]) => `${entry.stage} ${entry.what}: ${entry.reason}`;
  const first = new Set(a.skipped.map(key));
  const second = new Set(b.skipped.map(key));

  return [
    ...[...first].filter((entry) => !second.has(entry)).map((entry) => `only in run 1 — ${entry}`),
    ...[...second].filter((entry) => !first.has(entry)).map((entry) => `only in run 2 — ${entry}`),
  ].slice(0, 6);
}

/**
 * The first few places two reports disagree, as `path: a != b`.
 *
 * Walks the two objects in parallel rather than diffing serialised text, so the
 * answer names a field a reader can go and look at instead of a line number in a
 * 24,000-line document.
 */
function firstDifferences(a: unknown, b: unknown, path = '', out: string[] = []): string[] {
  if (out.length >= 6) return out;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.push(`${path}: length ${a.length} != ${b.length}`);
      return out;
    }
    for (let i = 0; i < a.length; i += 1) firstDifferences(a[i], b[i], `${path}[${i}]`, out);
    return out;
  }

  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      firstDifferences(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
        path === '' ? key : `${path}.${key}`,
        out,
      );
    }
    return out;
  }

  if (a !== b) out.push(`${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  return out;
}

async function validateRepo(repo: RepoSpec, probed: boolean): Promise<RepoResult> {
  const root = join(VALIDATION_ROOT, repo.name);
  const readFileText = (path: string) => readFile(path, 'utf8');

  const first = await runPipeline(repo, probed);

  // --- (a) the range invariant, over real code -----------------------------------
  const { checked, failures } = await checkRanges(first.scanned.references, readFileText);

  // --- (f) determinism: two whole runs -------------------------------------------
  //
  // Every byte of the report, `skipped` included. `environmentNotes` quotes any
  // `skipped` entry that differs, because naming the asset is what makes a red verdict
  // actionable, and `determinismDiff` says where the reports differ, since a bare `false`
  // on a 24,000-line report cannot be acted on.
  const second = await runPipeline(repo, probed);
  const deterministic = sameReport(first.report, second.report);
  const determinismDiff = deterministic ? [] : firstDifferences(first.report, second.report);
  const environmentNotes = skippedDifferences(first.report, second.report);

  // --- (f) and a third run from a different working directory ----------------------
  // `Reference.file` is absolute, and four upstream types carry an absolute path beside
  // their relative one, so output that depends on the working directory is a real risk.
  const originalCwd = cwd();
  chdir(tmpdir());
  const elsewhere = await runPipeline(repo, probed);
  chdir(originalCwd);
  const cwdIndependent = sameReport(first.report, elsewhere.report);
  const cwdDiff = cwdIndependent ? [] : firstDifferences(first.report, elsewhere.report);

  // --- (f) and no absolute path in the output at all -------------------------------
  const { clean: noAbsolutePath, evidence: absolutePathEvidence } = checkNoAbsolutePath(
    first.report,
    first.human,
    root,
  );

  // --- (b) the false-negative sweep -----------------------------------------------
  const unaccounted = await falseNegativeSweep(root, first.graph, first.references);

  // --- (d) every broken opened, every dead grepped, by an oracle that is not the engine
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
    determinismDiff,
    cwdDiff,
    environmentNotes,
    cwdIndependent,
    noAbsolutePath,
    absolutePathEvidence,
    unaccounted,
    verified,
    report: first.report,
    human: first.human,
    diagnostics: first.diagnostics,
    scanDiagnostics: first.scanDiagnostics,
  };
}

/**
 * That no absolute path reaches the output.
 *
 * `JSON.stringify` escapes a native Windows path to `E:\\PERSONAL…`, so the root is
 * searched for in both its escaped and its POSIX spelling, alongside any Windows
 * absolute path or drive letter. It returns what it found, so a failure names itself
 * instead of being one boolean.
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
  // Not any string containing a backslash, which is what `report.test.ts` checks on the
  // fixtures: a raw path in a CSS-in-JS template on `shadcn-ui` holds one, reported
  // exactly as its author wrote it. That check holds on the fixtures only because no
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
 * The range invariant: `source.slice(start, end) === rawPath`, for every reference.
 *
 * One cheap check that catches the whole class of offset bugs, the class that silently
 * corrupts a file at rewrite time and is invisible any other way.
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
 * The false-negative sweep.
 *
 * A reference the adapters miss looks clean in the audit, then the rewrite changes the
 * image without updating it and the build breaks with nothing reported. So every asset's
 * filename is searched for across the whole repository, and every hit the graph did not
 * link is triaged: a genuine miss (fix the adapter, add a fixture) or correctly out of
 * scope. A person only has to look at the hits triage cannot explain.
 */
async function falseNegativeSweep(
  root: string,
  graph: Graph,
  references: readonly Reference[],
): Promise<Triaged[]> {
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
  const unaccounted: Triaged[] = [];
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

        unaccounted.push(
          triage(
            {
              asset,
              file: relative(root, file).replaceAll('\\', '/'),
              line: lineOf(text, match.index),
              text: lineText(text, match.index),
            },
            claimed,
          ),
        );
      }
      match = pattern.exec(text);
    }
  }

  return unaccounted.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.asset.localeCompare(b.asset),
  );
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

/** Per-repository artefacts: the report, and the worksheet a person reviews it with. */
async function writeArtifacts(outDir: string, result: RepoResult): Promise<void> {
  const name = labelOf(result.repo);
  await writeFile(
    join(outDir, `${name}.report.json`),
    `${JSON.stringify(result.report, null, 2)}\n`,
    'utf8',
  );
  await writeFile(join(outDir, `${name}.report.txt`), result.human, 'utf8');
  await writeFile(join(outDir, `${name}.review.md`), worksheet(result), 'utf8');
  await writeFile(join(outDir, `${name}.sweep.md`), sweepLog(result), 'utf8');
  await writeFile(join(outDir, `${name}.diagnostics.txt`), diagnosticsLog(result), 'utf8');
}

/**
 * The imaging library's own words, sorted, in a file no determinism check reads.
 *
 * Sorted so a person diffing two of these by hand sees real changes rather than
 * scheduling noise. That is a convenience for a reader and not a determinism claim:
 * the whole reason this text lives here is that it is not stable enough to make one.
 */
function diagnosticsLog(result: RepoResult): string {
  const lines = result.diagnostics
    .map((entry) => `${entry.asset}\t${entry.measurement}\t${entry.code}\t${entry.detail}`)
    .sort();

  const parserLines = result.scanDiagnostics
    .map((entry) => `${entry.relative}\t${entry.adapterId}\t${entry.detail}`)
    .sort();

  return [
    `# ${labelOf(result.repo)} - what the libraries said`,
    '#',
    '# Not part of the report, and not compared between runs. libvips does not word the',
    '# same failure identically every time, and PostCSS and Babel are free to reword',
    '# theirs on any upgrade, so none of this text can appear in an artefact that is',
    '# promised to be byte-identical. Upfly own classification is in the report.',
    '',
    '## the imaging library, on assets it could not measure',
    ...(lines.length === 0 ? ['(nothing failed to decode)'] : lines),
    '',
    '## the parsers, on source files they could not read',
    ...(parserLines.length === 0 ? ['(nothing failed to parse)'] : parserLines),
    '',
  ].join('\n');
}

/**
 * The review worksheet for one repository.
 *
 * Not a summary and not a list of commands: `verify.ts` has already run every check a
 * machine can, so this reports its verdicts and expands only what a person has to decide.
 */
function worksheet(result: RepoResult): string {
  const { repo } = result;
  const root = `${VALIDATION_ROOT}/${repo.name}`;
  const needsHuman = result.unaccounted.filter((entry) => entry.explanation === null);

  const lines = [
    `# ${labelOf(repo)} — §5.1(c)/(d) review worksheet`,
    '',
    `Repo \`${repo.name}\` at \`${repo.sha}\`${repo.unconfigured === true ? ', run with NO configuration: serving roots detected and inferred exactly as a first run does (R147)' : ''}.`,
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
    `linked by the graph, and ${result.unaccounted.length - needsHuman.length} were explained`,
    'mechanically — a file type no adapter reads, an absolute URL, a commented-out line, prose, or a',
    'line naming a different file that shares a basename. The rest are below, **grouped by shape so',
    'the same decision is made once**.',
    '',
    'The question for each: **if this image were renamed, would this line break?** If yes it is a',
    'miss and needs an adapter fix plus a fixture. If no, write down why.',
    '',
  );

  if (needsHuman.length === 0) {
    lines.push('_Nothing unaccounted for in a file an adapter claims._', '');
  } else {
    for (const group of groupResidue(needsHuman)) {
      lines.push(`### ${group.label}`, '');
      // Every one of them: a cap here would be a silent skip inside the pass that exists
      // to find silent skips. The full list is also in `<repo>.sweep.md`.
      for (const entry of group.entries) {
        lines.push(
          `- [ ] \`${entry.file}:${entry.line}\` → \`${entry.asset}\``,
          `      \`${entry.text}\``,
        );
      }
      lines.push('');
    }
  }

  lines.push(
    '## 5. Read the report as a stranger',
    '',
    `\`${labelOf(repo)}.report.txt\` is the human output. §5.1(d): if the numbers are not obvious in`,
    'ten seconds, or the skipped list reads as noise, the report has failed even with a correct',
    'graph behind it.',
    '',
  );

  return `${lines.join('\n')}\n`;
}

/** One line saying whether any finding came back false, before any detail. */
function verdictHeadline(verified: VerifyResult): string {
  const wrong = verified.items.filter((item) => item.verdict === 'confirmed-false').length;
  const unclear = verified.items.filter((item) => item.verdict === 'ambiguous').length;

  // Every branch says `came back`, which agrees with any count, so none can print
  // "1 are ambiguous" or dodge the agreement with "finding(s)". The total is printed too:
  // the number of items checked can change without the false count moving, and a bare
  // "0 confirmed-false" would not show that.
  const headline =
    wrong > 0
      ? `**${wrong} of ${verified.items.length} came back confirmed-false — the gate is not passed.**`
      : unclear === 0
        ? `All ${verified.items.length} came back confirmed-genuine.`
        : `None came back false; ${unclear} of ${verified.items.length} came back ambiguous, for you to decide.`;

  return `${headline}\n\n${BLIND_SPOT}`;
}

/**
 * What the oracle cannot see, stated next to its verdicts.
 *
 * Independent in implementation is not independent in assumption. The oracle shares no
 * code with the engine, but both search for strings, so an asset kept alive by something
 * that names it nowhere, such as a framework's file convention, fools them both. A
 * "0 confirmed-false" that does not say so claims more than it checked.
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
 * `confirmed-false` first, because one of those fails the validation, then `ambiguous`,
 * which is the actual work, then `confirmed-genuine` collapsed to a short list: expanding
 * items a machine already checked buries the ones a person has to decide.
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

/** One judgement call, and everything it covers. */
interface ResidueGroup {
  readonly label: string;
  readonly entries: Triaged[];
}

/**
 * The residue, collapsed to the decisions it actually contains.
 *
 * Two passes, because one key cannot do it. Many hits in one file, such as a data module
 * naming a hundred different logos, are one decision, so a file with several hits is one
 * group. One hit in each of many files, such as a sentence translated into fourteen
 * languages, is also one decision, so the hits left over group by the asset and shape
 * they share. Grouping by what items have in common beats capping the list.
 */
function groupResidue(entries: readonly Triaged[]): ResidueGroup[] {
  const byFile = new Map<string, Triaged[]>();
  for (const entry of entries) {
    byFile.set(entry.file, [...(byFile.get(entry.file) ?? []), entry]);
  }

  const groups: ResidueGroup[] = [];
  const singles: Triaged[] = [];

  for (const [file, group] of byFile) {
    if (group.length > 1) {
      groups.push({
        label: `\`${file}\` — ${group.length} hits (${shapesIn(group)})`,
        entries: group,
      });
    } else if (group[0] !== undefined) {
      singles.push(group[0]);
    }
  }

  const byAsset = new Map<string, Triaged[]>();
  for (const entry of singles) {
    const key = `${entry.asset}\u0000${entry.shape ?? ''}`;
    byAsset.set(key, [...(byAsset.get(key) ?? []), entry]);
  }

  for (const group of byAsset.values()) {
    const first = group[0];
    if (first === undefined) continue;
    groups.push({
      label:
        group.length === 1
          ? `\`${first.file}\` — 1 hit (${first.shape ?? ''})`
          : `\`${first.asset}\` — named once in each of ${group.length} files (${first.shape ?? ''})`,
      entries: group,
    });
  }

  return groups.sort(
    (a, b) => b.entries.length - a.entries.length || a.label.localeCompare(b.label),
  );
}

/** The shapes present in a group, so the label still says what kind of line it is. */
function shapesIn(entries: readonly Triaged[]): string {
  const shapes = [...new Set(entries.map((entry) => entry.shape ?? 'unclassified'))].sort();
  return shapes.join(', ');
}

/** Every sweep hit and what triage made of it: the audit trail for the sweep itself. */
function sweepLog(result: RepoResult): string {
  const lines = [
    `# ${labelOf(result.repo)} — §5.1(b) sweep, every hit`,
    '',
    `${result.unaccounted.length} grep hits the graph did not link. This is the complete list,`,
    'including the ones triage explained — so the triage rules themselves can be reviewed rather',
    'than trusted.',
    '',
  ];

  const explained = result.unaccounted.filter((entry) => entry.explanation !== null);
  const byReason = new Map<string, number>();
  for (const entry of explained) {
    const reason = entry.explanation ?? '';
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  }

  lines.push(`## Explained — ${explained.length}`, '');
  for (const [reason, count] of [...byReason].sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${count} × ${reason}`);
  }
  lines.push('');

  for (const entry of explained) {
    lines.push(`- \`${entry.file}:${entry.line}\` → \`${entry.asset}\` — ${entry.explanation}`);
  }
  lines.push('');

  const residue = result.unaccounted.filter((entry) => entry.explanation === null);
  lines.push(`## Needs a decision — ${residue.length}`, '');
  for (const group of groupResidue(residue)) {
    lines.push(`### ${group.label}`, '');
    for (const entry of group.entries) {
      lines.push(`- \`${entry.file}:${entry.line}\` → \`${entry.asset}\``, `  \`${entry.text}\``);
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function summarise(result: RepoResult): string {
  const counts = result.report.summary.findings;
  const needsHuman = result.unaccounted.filter((entry) => entry.explanation === null).length;

  return [
    `  files ${result.files}, assets ${result.assets}, references ${result.references}`,
    `  (a) range invariant: ${result.rangeInvariantChecked} checked, ${result.rangeInvariantFailures.length} failures`,
    `  (b) unaccounted grep hits: ${result.unaccounted.length} total, ${needsHuman} need a human`,
    `  (f) deterministic: ${result.deterministic}, cwd-independent: ${result.cwdIndependent}, no absolute path: ${result.noAbsolutePath}`,
    ...result.determinismDiff.map((entry) => `      🔴 FINDINGS DIFFER between runs: ${entry}`),
    ...result.cwdDiff.map((entry) => `      🔴 FINDINGS DIFFER by cwd: ${entry}`),
    ...result.environmentNotes.map(
      (entry) => `      🔴 SKIPPED LIST DIFFERS between runs: ${entry}`,
    ),
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
      `| ${labelOf(result.repo)} | ${result.files} | ${result.assets} | ${result.references} | ${result.rangeInvariantChecked} | ${result.rangeInvariantFailures.length} | ${needsHuman} | ${result.deterministic ? 'yes' : 'NO'} | ${result.cwdIndependent ? 'yes' : 'NO'} | ${result.noAbsolutePath ? 'yes' : 'NO'} | ${result.graphMs} |`,
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
      `| ${labelOf(result.repo)} | ${counts.broken} | ${counts.dead} | ${counts['possibly-dead']} | ${counts.oversized} | ${counts['format-opportunity']} |`,
    );
  }
  lines.push('');

  return `${lines.join('\n')}\n`;
}

await main();
