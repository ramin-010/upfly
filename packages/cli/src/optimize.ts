/**
 * `upfly optimize`: the plan, and with `--apply` the run, and with `--commit` its commit.
 *
 * Before anything is written, git has to be able to show the run as the only change: the
 * project folder has no uncommitted changes, unless the user allows them. Only the project
 * folder is looked at, and committed, even when the repository around it is larger.
 */

import { resolve } from 'node:path';
import {
  type Manifest,
  type OptimizationPlan,
  type OptimizeProjectResult,
  type PublicPolicy,
  UPFLY_DIRECTORY,
  UpflyError,
  buildReport,
  createNodeFileStore,
  formatBytes,
  optimizeProject,
  pathsTouched,
  processIsAlive,
  readLockHolder,
  readManifest,
  renderReport,
} from 'upfly-core';
import type { OptimizeOptions } from './args.js';
import { isDirectory } from './audit.js';
import { type UpflyConfig, loadConfig } from './config.js';
import { EXIT_CODES, type ExitCode } from './exit-codes.js';
import {
  type GitState,
  RUN_TRAILER,
  commitPaths,
  gitState,
  identityProblem,
  ignoredPaths,
} from './git.js';
import { type Io, emit, progressReporter, stopWith } from './output.js';
import { count, renderPlan, writtenByKind } from './plan-text.js';

/** A reason to stop, with the exit code and, for a refusal, the name `--json` gives it. */
interface Refusal {
  readonly code: ExitCode;
  readonly reason?: string;
  readonly message: string;
}

/**
 * Plans the project's optimization and, with `--apply`, carries it out.
 *
 * @param options the parsed command line
 * @param io the streams and environment to use
 * @returns 0 when the run finished, even with nothing to do; 2 for a usage or configuration
 * error; 3 when it refused to write
 */
export async function runOptimize(options: OptimizeOptions, io: Io): Promise<ExitCode> {
  const stop = (refusal: Refusal): ExitCode =>
    stopWith(io, options, refusal.code, refusal.message, refusal.reason);
  const project = await openProject(options);
  if ('code' in project) return stop(project);
  const { root, settings } = project;

  const git = gitState(root);
  const unfinished = await unfinishedRun(root);
  if (options.apply) {
    const refusal = unfinished ?? gitRefusal(git, options, root);
    if (refusal !== null) return stop(refusal);
  }

  const policy: PublicPolicy = options.replace
    ? 'replace'
    : (settings.publicPolicy ?? 'keep-original');
  const result = await carryOut(options, io, root, settings, policy);
  if ('code' in result) return stop(result);

  let commit: string | null = null;
  const { manifest, plan } = result.optimize;
  if (options.commit && manifest !== null) {
    const committed = commitRun(root, manifest, plan);
    if (typeof committed !== 'string') return stop(committed);
    commit = committed;
  }

  write(options, io, result, { policy, git, commit, notes: notes(options, git, unfinished) });
  return EXIT_CODES.OK;
}

/** The project directory and its settings, or why the command cannot use them. */
async function openProject(
  options: OptimizeOptions,
): Promise<{ readonly root: string; readonly settings: UpflyConfig } | Refusal> {
  const root = resolve(options.dir);
  if (!isDirectory(root)) {
    return { code: EXIT_CODES.USAGE, message: `${options.dir} is not a directory` };
  }
  const config = await loadConfig(root);
  if (config.kind === 'refused') {
    return { code: EXIT_CODES.ABORTED, reason: config.reason, message: config.message };
  }
  if (config.kind === 'invalid') {
    return { code: EXIT_CODES.USAGE, message: `${config.file} ${config.message}` };
  }
  return { root, settings: config.kind === 'loaded' ? config.config : {} };
}

/** Runs the engine, turning each of its refusals into one the command reports. */
async function carryOut(
  options: OptimizeOptions,
  io: Io,
  root: string,
  settings: UpflyConfig,
  policy: PublicPolicy,
): Promise<OptimizeProjectResult | Refusal> {
  const publicDirs = options.publicDirs ?? settings.publicDirs ?? null;
  const progress = progressReporter(io, 'optimize', options.json);
  let ignored: string[] = [];

  let result: OptimizeProjectResult;
  try {
    result = await optimizeProject({
      root,
      ...(publicDirs === null ? {} : { declared: { dirs: publicDirs, declared: true } }),
      format: options.format ?? settings.format ?? 'webp',
      publicPolicy: policy,
      apply: options.apply,
      extraIgnores: [...(settings.exclude ?? []), ...options.exclude],
      onProgress: (event) => progress.update(event),
      // Decided on the finished plan, so that a commit that could not hold every file the
      // run writes stops the run before it writes any.
      ...(options.commit
        ? {
            beforeWrite: (plan: OptimizationPlan) => {
              ignored = ignoredPaths(root, plannedPaths(plan));
              return ignored.length === 0;
            },
          }
        : {}),
    });
  } catch (error) {
    progress.clear();
    const refusal = await engineRefusal(error, root);
    if (refusal === null) throw error;
    return refusal;
  }
  progress.clear();

  const { refusal } = result.optimize;
  if (refusal !== null) {
    return {
      code: EXIT_CODES.ABORTED,
      reason: 'SERVING_ROOT_UNKNOWN',
      message: `${refusal.reason} Name it with --public <dir>, or publicDirs in the config file; use . for the project root.`,
    };
  }
  if (ignored.length > 0) {
    return {
      code: EXIT_CODES.ABORTED,
      reason: 'IGNORED_BY_GIT',
      message: `Git ignores ${count(ignored.length, 'file')} this run would write: ${some(ignored)}. One commit could not hold the whole run, so nothing was written. Run without --commit, or change what git ignores.`,
    };
  }
  return result;
}

/** Commits exactly the files the run wrote, and returns the commit's hash. */
function commitRun(root: string, manifest: Manifest, plan: OptimizationPlan): string | Refusal {
  try {
    return commitPaths(root, pathsTouched(manifest), commitMessage(manifest, plan));
  } catch (error) {
    return {
      code: EXIT_CODES.INTERNAL,
      reason: 'GIT_COMMIT_FAILED',
      message: `The run was applied, but git did not commit it (${firstLine(error)}). Its files are written: commit them yourself, or run \`upfly undo\` to put every file back.`,
    };
  }
}

/**
 * A run in progress, or one that stopped part way, either of which a new write must wait
 * for. The engine refuses both as well; asking first says so before the project is read.
 */
async function unfinishedRun(root: string): Promise<Refusal | null> {
  const store = createNodeFileStore(root);
  const holder = await readLockHolder(store);
  if (holder !== null && processIsAlive(holder.pid)) {
    return {
      code: EXIT_CODES.ABORTED,
      reason: 'TRANSACTION_LOCKED',
      message: `Another Upfly run is in progress (run ${holder.runId}, process ${holder.pid}, started ${holder.startedAt}). Wait for it to finish, then run this again.`,
    };
  }
  let manifest: Manifest | null = null;
  try {
    manifest = await readManifest(store);
  } catch {
    // A record this build cannot read is left for the engine's own check at write time.
  }
  if (manifest?.state !== 'pending') return null;
  return {
    code: EXIT_CODES.ABORTED,
    reason: 'TRANSACTION_INTERRUPTED',
    message: `The last run (${manifest.runId}, started ${manifest.startedAt}) stopped before it finished. Run \`upfly undo\` to put back every file it wrote, then run this again.`,
  };
}

/** Whether git lets this run write, and commit, in `root`. */
function gitRefusal(git: GitState, options: OptimizeOptions, root: string): Refusal | null {
  if (git.kind !== 'repository' || !git.tracked) {
    const why = unprotected(git, options.dir);
    if (options.commit) {
      return {
        code: EXIT_CODES.USAGE,
        reason: 'NO_REPOSITORY',
        message: `--commit needs a git repository that tracks this folder, and ${why}. Run without --commit.`,
      };
    }
    if (options.allowDirty) return null;
    return {
      code: EXIT_CODES.ABORTED,
      reason: 'NO_REPOSITORY',
      message: `${capitalise(why)}, so git could not put these files back. \`upfly undo\` can: to write without git, add --allow-dirty.`,
    };
  }

  const changed = git.changed.filter((path) => !ownPath(path));
  if (changed.length > 0 && !options.allowDirty) {
    return {
      code: EXIT_CODES.ABORTED,
      reason: 'UNCOMMITTED_CHANGES',
      message: `Uncommitted changes in ${count(changed.length, 'file')} under this folder${inRepository(git)}: ${some(changed)}. Commit or stash them first, so that this run's changes are the only ones to review, or add --allow-dirty to write anyway.`,
    };
  }

  if (options.commit) {
    const identity = identityProblem(root);
    if (identity !== null) {
      return {
        code: EXIT_CODES.USAGE,
        reason: 'NO_GIT_IDENTITY',
        message: `git has no name and email to commit with (${identity}). Set user.name and user.email with git config, or run without --commit.`,
      };
    }
  }
  return null;
}

/** Why git offers this folder no protection, as a clause. */
function unprotected(git: GitState, dir: string): string {
  switch (git.kind) {
    case 'no-git':
      return 'git was not found on this computer';
    case 'not-a-repository':
      return `${dir} is not in a git repository`;
    case 'repository':
      return `the git repository at ${git.top} tracks no file in this folder`;
  }
}

/** The engine's own refusals, as exit 3 with what to do; null for anything else. */
async function engineRefusal(error: unknown, root: string): Promise<Refusal | null> {
  if (!(error instanceof UpflyError)) return null;
  switch (error.code) {
    case 'TRANSACTION_LOCKED':
      return { code: EXIT_CODES.ABORTED, reason: error.code, message: error.message };
    case 'TRANSACTION_INTERRUPTED':
      return {
        code: EXIT_CODES.ABORTED,
        reason: error.code,
        message: `${error.message} Run \`upfly undo\`, then run this again.`,
      };
    case 'TRANSACTION_PLAN_INVALID':
    case 'TRANSACTION_FOREIGN_CHANGE': {
      // Either can happen before the first write or part way through; only part way
      // through is there a pending record for undo to follow.
      const stopped = (await unfinishedRun(root))?.reason === 'TRANSACTION_INTERRUPTED';
      return {
        code: EXIT_CODES.ABORTED,
        reason: error.code,
        message: stopped
          ? `${error.message} The run stopped part way: \`upfly undo\` puts back every file it wrote.`
          : error.message,
      };
    }
    default:
      return null;
  }
}

/** Every project path the plan would create, rewrite or remove. */
function plannedPaths(plan: OptimizationPlan): string[] {
  const paths = new Set<string>();
  for (const conversion of plan.conversions) {
    paths.add(conversion.target);
    if (conversion.replacesOriginal) paths.add(conversion.asset);
  }
  for (const rewrite of plan.rewrites) paths.add(rewrite.file);
  return [...paths].sort();
}

/** A path inside Upfly's own folder, which the run writes and git is told to ignore. */
function ownPath(path: string): boolean {
  return path === UPFLY_DIRECTORY || path.startsWith(`${UPFLY_DIRECTORY}/`);
}

function commitMessage(manifest: Manifest, plan: OptimizationPlan): string {
  const { created, changed, removed } = writtenByKind(manifest);
  const references = plan.rewrites.reduce((sum, rewrite) => sum + rewrite.edits.length, 0);
  const saved = plan.conversions.reduce((sum, conversion) => sum + conversion.savedBytes, 0);
  const lines = [
    'Optimize images with Upfly',
    '',
    `Converted ${count(created.length, 'image')}, ${formatBytes(saved)} smaller in total, and updated ${count(references, 'reference')} in ${count(changed.length, 'file')}.`,
  ];
  if (removed.length > 0) {
    lines.push(`Removed ${count(removed.length, 'original')} whose references all moved.`);
  }
  lines.push('', `${RUN_TRAILER}: ${manifest.runId}`);
  return `${lines.join('\n')}\n`;
}

interface Outcome {
  readonly policy: PublicPolicy;
  readonly git: GitState;
  readonly commit: string | null;
  readonly notes: readonly string[];
}

/** Things worth knowing before running with `--apply`, said on a dry run. */
function notes(options: OptimizeOptions, git: GitState, unfinished: Refusal | null): string[] {
  if (options.apply) return [];
  const said: string[] = [];
  if (unfinished !== null) said.push(unfinished.message);
  if (git.kind === 'repository' && git.prefix !== '') {
    said.push(
      `This folder is ${git.prefix} in the git repository at ${git.top}. --apply checks, and --commit commits, only the files under it.`,
    );
  }
  if (git.kind === 'repository' && git.tracked) {
    const changed = git.changed.filter((path) => !ownPath(path));
    if (changed.length > 0) {
      said.push(
        `Uncommitted changes in ${count(changed.length, 'file')} under this folder: --apply refuses to write until they are committed, unless run with --allow-dirty.`,
      );
    }
  } else {
    said.push(
      `${capitalise(unprotected(git, options.dir))}: --apply writes here only with --allow-dirty, and \`upfly undo\` is then the way back.`,
    );
  }
  return said;
}

function write(options: OptimizeOptions, io: Io, result: OptimizeProjectResult, outcome: Outcome) {
  const { pipeline, optimize: run } = result;
  const report = buildReport({
    graph: pipeline.graph,
    audit: pipeline.audit,
    discovery: pipeline.discovery,
    sweep: pipeline.sweep,
    servingRoots: pipeline.servingRoots,
    ...(pipeline.probes === undefined ? {} : { probes: pipeline.probes }),
    declined: run.plan.declined,
    includeDeclined: options.includeDeclined,
    includeDiscarded: options.includeDiscarded,
    includeUnusedVectors: options.includeUnusedSvg,
  });
  const repository =
    outcome.git.kind === 'repository' ? { top: outcome.git.top, path: outcome.git.prefix } : null;

  if (options.json) {
    for (const diagnostic of pipeline.diagnostics) {
      emit(io, { type: 'diagnostic', command: 'optimize', source: 'image', ...diagnostic });
    }
    for (const diagnostic of pipeline.scanDiagnostics) {
      emit(io, { type: 'diagnostic', command: 'optimize', source: 'parser', ...diagnostic });
    }
    emit(io, {
      type: 'result',
      command: 'optimize',
      exitCode: EXIT_CODES.OK,
      apply: options.apply,
      plan: run.plan,
      run:
        run.manifest === null ? null : { id: run.manifest.runId, ...writtenByKind(run.manifest) },
      commit: outcome.commit,
      repository,
      notes: outcome.notes,
      report,
    });
    return;
  }

  const lines = [
    renderReport(report).trimEnd(),
    '',
    ...renderPlan(run.plan, pipeline.graph, outcome.policy),
  ];
  lines.push(...outcomeLines(options, run.manifest, outcome));
  for (const note of outcome.notes) lines.push(`Note: ${note}`);
  io.stdout.write(`${lines.join('\n')}\n`);
}

function outcomeLines(
  options: OptimizeOptions,
  manifest: Manifest | null,
  outcome: Outcome,
): string[] {
  if (!options.apply) {
    return ['Dry run: nothing was written. Run the same command with --apply to write this plan.'];
  }
  if (manifest === null) return ['Nothing was written: the plan has nothing to do.'];
  const { created, changed, removed } = writtenByKind(manifest);
  const lines = [
    `Written as run ${manifest.runId}: ${count(created.length, 'file')} created, ${changed.length} changed, ${removed.length} removed. \`upfly undo\` puts them all back.`,
  ];
  if (outcome.commit !== null && outcome.git.kind === 'repository') {
    const short = outcome.commit.slice(0, 12);
    lines.push(
      `Committed as ${short}, one commit holding exactly those files. \`git revert ${short}\` undoes it.`,
    );
    if (outcome.git.prefix !== '') {
      lines.push(
        `The commit is in the git repository at ${outcome.git.top}, and holds only files under ${outcome.git.prefix}.`,
      );
    }
  }
  return lines;
}

/** `, in the git repository at <top>` when the repository is larger than the project. */
function inRepository(git: GitState): string {
  return git.kind === 'repository' && git.prefix !== ''
    ? ` in the git repository at ${git.top}, where this folder is ${git.prefix}`
    : '';
}

/** Up to three of the paths, so the reader knows which, and how many more there are. */
function some(paths: readonly string[]): string {
  const more = paths.length > 3 ? ` and ${paths.length - 3} more` : '';
  return `${paths.slice(0, 3).join(', ')}${more}`;
}

function capitalise(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0] ?? message;
}
