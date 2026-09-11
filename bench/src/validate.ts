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
  CONVENTIONAL_SERVING_ROOTS,
  type Graph,
  IMAGE_EXTENSIONS,
  type Reference,
  type Report,
  type ServingRoots,
  audit,
  buildGraph,
  buildReport,
  createSharpProbe,
  defaultAdapters,
  detectConventionRoots,
  discover,
  linkedPaths,
  loadAliases,
  probeAssets,
  renderReport,
  resolveReferences,
  scanSources,
  sweepForMentions,
} from 'upfly-core';
import { REPOS, type RepoSpec, VALIDATION_ROOT, labelOf } from './repos.js';
import { type Triaged, triage } from './triage.js';
import { type ItemVerdict, type VerifyResult, verifyFindings } from './verify.js';

const ADAPTERS: readonly Adapter[] = defaultAdapters;

/** Lowercased asset basenames, for the mention pass `scan` does while reading. */
function basenamesOf(assets: readonly Asset[]): Set<string> {
  return new Set(
    assets.map((asset) => asset.relative.slice(asset.relative.lastIndexOf('/') + 1).toLowerCase()),
  );
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
  /** Where two runs disagreed, when they did. A bare `false` cannot be acted on. */
  readonly determinismDiff: readonly string[];
  readonly cwdDiff: readonly string[];
  /** `skipped` entries that differed between runs. Environmental, not a defect. */
  readonly environmentNotes: readonly string[];
  readonly cwdIndependent: boolean;
  readonly noAbsolutePath: boolean;
  /** Whatever proved the absolute-path check wrong, so a failure names itself. */
  readonly absolutePathEvidence: string[];
  readonly unaccounted: Triaged[];
  /** §5.1(d), the automated half: a verdict per finding, from an independent oracle. */
  readonly verified: VerifyResult;
  readonly report: Report;
  readonly human: string;
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

  // ⚠️ **A partial run must not leave behind something that looks complete.** `--repo=` and
  // `--no-probe` each produce results that are true but are not the gate, and SUMMARY.md is
  // the file a number gets quoted from. It used to be rewritten with only the row that ran,
  // silently discarding the others — so a one-repo run left an artefact that read as a full
  // validation of a suite with one repo in it, and nothing on the page said otherwise.
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
 * What SUMMARY.md says when the run was not the whole gate.
 *
 * Keeps the table, because the rows that ran are real — and puts the limitation above it
 * rather than in a footnote, because a limitation below the numbers is one nobody reads.
 * §3.5 says which tier to run for which change; this is what stops the cheap tier being
 * mistaken for the expensive one afterwards.
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
 * Every stage, run for real, from a cold start.
 *
 * It is a function rather than inline code because §5.1(f) asks whether *two runs*
 * agree, and the first version of this file answered that by calling `buildReport`
 * twice on one set of in-memory objects. That proves `buildReport` is pure and
 * nothing else: with `Math.random()` sorting the references it still reported
 * `deterministic: true` while the written JSON differed by 318 lines. Determinism
 * has to be measured over the whole pipeline or it is not measured at all.
 */
/**
 * The serving roots one run resolves against.
 *
 * Every repository here has hand-tuned serving roots, which means the corpus has
 * validated the CONFIGURED experience five times and the unconfigured one never. A
 * first run always has no configuration, so the unconfigured case is what everybody
 * meets first. `unconfigured` runs a repo the way a stranger would meet it: the
 * convention guess, marked as a guess.
 */
function servingRootsFor(repo: RepoSpec): ServingRoots {
  return repo.unconfigured === true
    ? CONVENTIONAL_SERVING_ROOTS
    : { dirs: repo.publicDirs, declared: true };
}

async function runPipeline(repo: RepoSpec, probed: boolean): Promise<PipelineResult> {
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
  // B1: the aliases the project declares, read from the files `discover` already
  // found. No second walk — the config files are ordinary discovered files.
  const aliases = await loadAliases({
    root: discovery.root,
    files: [...discovery.sourceFiles, ...discovery.unscannedFiles],
    readFile: readFileText,
    exists: (path) => existsSync(path),
  });
  const references = resolveReferences(scanned.references, {
    root: discovery.root,
    assets: discovery.assets,
    servingRoots: servingRootsFor(repo),
    excludedRoots: discovery.excludedRoots,
    aliases,
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
  // ⚠️ **The dominant cost of a validate run, and irrelevant to nearly every question this
  // phase asked.** Encoding 300 images with sharp says nothing about whether a reference
  // was detected, yet it ran on every invocation — including ones that changed a single
  // word in a report heading. `--no-probe` skips it; §3.5 says when to use which tier.
  //
  // `undefined` rather than `[]`: `audit` reads `probes !== undefined` as "was probed", so
  // an empty array would claim a measurement happened and report no savings, which is the
  // silent-lie shape rather than the honest one.
  const probes = probed
    ? await probeAssets(
        graph.assets.map((node) => node.asset),
        {
          probe: await createSharpProbe(),
          formats: ['webp'],
          maxEncodedAssets: 100,
        },
      )
    : undefined;
  // R17: which directories a framework reads certain filenames from. Derived from
  // the file list `discover` already produced, so no extra walk and no disk access
  // in `audit` — `next.config.mjs` is claimed by the JavaScript adapter, so it is
  // already a source file by the time this runs.
  const conventionRoots = detectConventionRoots([
    ...discovery.sourceFiles.map((file) => file.relative),
    ...discovery.unscannedFiles.map((file) => file.relative),
  ]);

  // Spread rather than `probes: probes`: under `exactOptionalPropertyTypes` an explicit
  // `undefined` is not the same as an absent key, and `audit` reads the key's presence as
  // "was probed". Omitting it is what makes `--no-probe` say *"savings not measured"*
  // rather than *"no savings found"*.
  const auditResult = await audit({
    graph,
    conventionRoots,
    sweep,
    readFile: readFileText,
    publicDirs: repo.publicDirs,
    ...(probes === undefined ? {} : { probes }),
  });
  // `includeUnusedVectors` so §5.1(d) can still verify what R22 demotes. It changes only
  // whether `unusedVectors.assets` is populated, never a finding or a count, so the
  // determinism comparison and every number in the artefacts are unaffected.
  const report = buildReport({
    graph,
    audit: auditResult,
    discovery,
    sweep,
    servingRoots: servingRootsFor(repo),
    ...(probes === undefined ? {} : { probes }),
    includeUnusedVectors: true,
  });

  return { discovery, scanned, references, graph, report, human: renderReport(report), graphMs };
}

/**
 * The part of a report a determinism claim is about (R38).
 *
 * Everything except `skipped`. Two runs that find the same images, the same
 * references and the same problems have agreed on what matters; a file that was
 * briefly unreadable under load has not changed what the engine concluded, only what
 * it managed to look at, and the report already says so in the entry itself.
 */
function substance(report: Report): Omit<Report, 'skipped'> {
  const { skipped: _skipped, ...rest } = report;
  return rest;
}

function sameSubstance(a: Report, b: Report): boolean {
  return JSON.stringify(substance(a)) === JSON.stringify(substance(b));
}

/**
 * Entries that appeared in one run's `skipped` list and not the other's.
 *
 * Quoted in full rather than counted: *"one more skip"* is not actionable, and the
 * whole reason this is separated from the determinism verdict is so it can be read
 * and judged rather than silently tolerated.
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
  // ⚠️ **A claim about the FINDINGS and REFERENCES, not about every byte (R38).** A
  // `skipped` entry that appears in one run and not the next is an I/O failure under
  // load — environmental, and rule 9 working exactly as designed by surfacing it. It
  // must stay visible, but it is not a determinism defect and must not look like one:
  // while the two were one boolean, a transient flake and a real correctness failure
  // were indistinguishable, which is precisely what cost time on railsgirls-com.
  const second = await runPipeline(repo, probed);
  const deterministic = sameSubstance(first.report, second.report);
  // A boolean that says `false` and nothing else cannot be acted on. This says WHERE,
  // which on a 24,000-line report is the whole difference.
  const determinismDiff = deterministic
    ? []
    : firstDifferences(substance(first.report), substance(second.report));
  const environmentNotes = skippedDifferences(first.report, second.report);

  // --- (f) and a third run from a different working directory ----------------------
  // §5.1(f) asks for this by name. `Reference.file` is absolute and four upstream
  // types carry an absolute path beside their relative one, so a cwd the output
  // depends on is a real risk rather than a theoretical one.
  const originalCwd = cwd();
  chdir(tmpdir());
  const elsewhere = await runPipeline(repo, probed);
  chdir(originalCwd);
  const cwdIndependent = sameSubstance(first.report, elsewhere.report);
  const cwdDiff = cwdIndependent
    ? []
    : firstDifferences(substance(first.report), substance(elsewhere.report));

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

/** Per-repo artefacts: the report, and the worksheet (c) and (d) are worked through. */
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
    `# ${labelOf(repo)} — §5.1(c)/(d) review worksheet`,
    '',
    `Repo \`${repo.name}\` at \`${repo.sha}\`${repo.unconfigured === true ? ', run with NO configuration: the convention serving root, which this repository does not have' : ''}.`,
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
      // Every one of them. The previous version stopped at 60 and said "…and N
      // more", which is a silent skip inside the pass that exists to find silent
      // skips; the full list also lives in `<repo>.sweep.md`.
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

/** One line saying whether anything failed the gate, before any detail. */
function verdictHeadline(verified: VerifyResult): string {
  const wrong = verified.items.filter((item) => item.verdict === 'confirmed-false').length;
  const unclear = verified.items.filter((item) => item.verdict === 'ambiguous').length;

  // ⚠️ Every branch is in the past tense, and that is deliberate. The middle one read
  // `${unclear} are ambiguous and need you`, which rendered "1 are ambiguous" on
  // eleventy-docs — the seventh instance of the verb-agreement bug in this project. The
  // first read `${wrong} finding(s)`, which dodges agreement by printing a bracket at the
  // reader. `came back` is invariant for every count, so neither is reachable now.
  //
  // The totals are here for a second reason: R22 moved 145 assets out of `findings`, so
  // the denominator can change without the numerator moving, and a bare "0 confirmed-false"
  // would not have shown that.
  const headline =
    wrong > 0
      ? `**${wrong} of ${verified.items.length} came back confirmed-false — the gate is not passed.**`
      : unclear === 0
        ? `All ${verified.items.length} came back confirmed-genuine.`
        : `None came back false; ${unclear} of ${verified.items.length} came back ambiguous, for you to decide.`;

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

/** One judgement call, and everything it covers. */
interface ResidueGroup {
  readonly label: string;
  readonly entries: Triaged[];
}

/**
 * The residue, collapsed to the decisions it actually contains.
 *
 * Two passes, because one key cannot do it and measuring showed why. Grouping by
 * **citing file** collapses astro-docs' 120 hits — every one of them
 * `src/data/logos.ts` — into a single decision; grouping by **asset** would explode
 * the same 120 back out, since they name 120 different logos. And the reverse holds
 * for the long tail: astro-docs' remaining 14 hits are one sentence in one document
 * translated into fourteen languages, and shadcn-ui's 36 JSON ones are two assets
 * across a generated registry. One hit each, same decision every time.
 *
 * So: files carrying several hits group by file; whatever is left over — one hit per
 * file — groups by the asset and shape those hits share. 228 items become 25
 * questions, and this is the third place in this phase where the fix for "a wall of
 * near-identical items" was to group by what they have in common rather than to cap
 * the list.
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

/** Every hit and what triage made of it — the audit trail for §5.1(b) itself. */
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
      (entry) => `      note (environmental, not a determinism failure): ${entry}`,
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
