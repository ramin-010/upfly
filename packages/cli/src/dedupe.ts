/**
 * `upfly dedupe`: for each set of byte-identical images, keep one copy and point the references
 * to the others at it. The plan unless `--apply`, and with `--commit` one commit, under the same
 * git rules as `optimize`. Nothing is deleted.
 */

import {
  type DedupePlan,
  type DedupeProjectResult,
  type DedupeSet,
  type KeptBecause,
  type Manifest,
  dedupeProject,
} from 'upfly-core';
import { formatBytes, pathsTouched } from 'upfly-core/internal';
import type { DedupeOptions } from './args.js';
import { scopeWords } from './audit.js';
import { EXIT_CODES, type ExitCode } from './exit-codes.js';
import { type GitState, RUN_TRAILER, commitPaths, gitState, ignoredPaths } from './git.js';
import { renderSummary } from './layout.js';
import {
  type Refusal,
  engineRefusal,
  gitRefusal,
  ignoredByGit,
  notes,
  openProject,
  outcomeLines,
  unfinishedRun,
} from './optimize.js';
import { type Io, emit, progressReporter, stopWith, stylesFor } from './output.js';
import { count, movingText, writtenByKind } from './plan-text.js';
import { warnIfNotKept, writeReport } from './report-file.js';
import { type NextStep, dedupeSummary, nextAfterPlan, nextAfterRun } from './summary.js';

/**
 * Plans keeping one copy of each set of identical images and, with `--apply`, writes it.
 *
 * @param options the parsed command line
 * @param io the streams and environment to use
 * @returns 0 when the run finished, even with nothing to do; 2 for a usage or configuration
 * error, such as a `--keep` that names no copy; 3 when it refused to write
 */
export async function runDedupe(options: DedupeOptions, io: Io): Promise<ExitCode> {
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

  const publicDirs = options.publicDirs ?? settings.publicDirs ?? null;
  const progress = progressReporter(io, 'dedupe', options.json);
  // Decided on the finished plan, so a bad `--keep`, or a commit that could not hold every file
  // the run writes, stops the run before it writes any.
  const guard: { refusal: Refusal | null } = { refusal: null };
  let result: DedupeProjectResult;
  try {
    result = await dedupeProject({
      root,
      ...(publicDirs === null ? {} : { declared: { dirs: publicDirs, declared: true } }),
      apply: options.apply,
      keep: options.keep,
      extraIgnores: [...(settings.exclude ?? []), ...options.exclude],
      onProgress: (event) => progress.update(event),
      beforeWrite: (plan) => {
        guard.refusal =
          keepProblem(plan, options.keep) ?? (options.commit ? ignoredRefusal(root, plan) : null);
        return guard.refusal === null;
      },
    });
  } catch (error) {
    progress.clear();
    const refusal = await engineRefusal(error, root);
    if (refusal === null) throw error;
    return stop(refusal);
  }
  progress.clear();
  const problem = guard.refusal ?? keepProblem(result.plan, options.keep);
  if (problem !== null) return stop(problem);

  let commit: string | null = null;
  if (options.commit && result.manifest !== null) {
    try {
      commit = commitPaths(
        root,
        pathsTouched(result.manifest),
        commitMessage(result.manifest, result.plan),
      );
    } catch (error) {
      return stop({
        code: EXIT_CODES.INTERNAL,
        reason: 'GIT_COMMIT_FAILED',
        message: `The run was applied, but git did not commit it (${firstLine(error)}). Its files are written: commit them yourself, or run \`upfly undo\` to put every file back.`,
      });
    }
  }

  write(options, io, result, {
    git,
    commit,
    unfinished: unfinished !== null,
    notes: notes(options, git, unfinished),
  });
  return EXIT_CODES.OK;
}

/** A `--keep` that names no copy, or two copies of one image, as a usage error. */
function keepProblem(plan: DedupePlan, keep: readonly string[]): Refusal | null {
  const setOf = new Map<string, number>();
  plan.sets.forEach((set, index) => {
    setOf.set(set.keep, index);
    for (const copy of set.copies) setOf.set(copy.path, index);
  });
  const strangers = keep.filter((path) => !setOf.has(path));
  if (strangers.length > 0) {
    return {
      code: EXIT_CODES.USAGE,
      message: `--keep ${strangers.join(', ')} ${strangers.length === 1 ? 'is' : 'are'} not one of the identical copies Upfly found. \`upfly audit\` lists each set of identical copies.`,
    };
  }
  for (const index of plan.sets.keys()) {
    const named = keep.filter((path) => setOf.get(path) === index).sort();
    if (named.length > 1) {
      return {
        code: EXIT_CODES.USAGE,
        message: `--keep names two copies of one image, ${named.join(' and ')}; keep one.`,
      };
    }
  }
  return null;
}

/** Why `--commit` cannot hold the run, when git ignores a file it would write. */
function ignoredRefusal(root: string, plan: DedupePlan): Refusal | null {
  const ignored = ignoredPaths(
    root,
    plan.rewrites.map((rewrite) => rewrite.file),
  );
  if (ignored.length === 0) return null;
  return {
    code: EXIT_CODES.ABORTED,
    reason: 'IGNORED_BY_GIT',
    message: ignoredByGit(root, ignored),
  };
}

function commitMessage(manifest: Manifest, plan: DedupePlan): string {
  const { changed } = writtenByKind(manifest);
  const references = plan.rewrites.reduce((sum, rewrite) => sum + rewrite.edits.length, 0);
  return [
    'Point identical copies of images at one file with Upfly',
    '',
    `Updated ${count(references, 'reference')} in ${count(changed.length, 'file')} to name one copy of each of ${count(plan.sets.length, 'set')} of identical images. No file was deleted.`,
    '',
    `${RUN_TRAILER}: ${manifest.runId}`,
    '',
  ].join('\n');
}

interface Outcome {
  readonly git: GitState;
  readonly commit: string | null;
  /** Whether an earlier run stopped part way, which `undo` has to finish first. */
  readonly unfinished: boolean;
  readonly notes: readonly string[];
}

function write(options: DedupeOptions, io: Io, result: DedupeProjectResult, outcome: Outcome) {
  const { plan, manifest } = result;
  if (options.json) {
    emit(io, {
      type: 'result',
      command: 'dedupe',
      exitCode: EXIT_CODES.OK,
      apply: options.apply,
      plan,
      run: manifest === null ? null : { id: manifest.runId, ...writtenByKind(manifest) },
      commit: outcome.commit,
      repository:
        outcome.git.kind === 'repository'
          ? { top: outcome.git.top, path: outcome.git.prefix }
          : null,
      notes: outcome.notes,
    });
    return;
  }
  const lines = [...planLines(plan), ...outcomeLines(options, manifest, outcome)];
  for (const note of outcome.notes) lines.push(`Note: ${note}`);
  const full = `${lines.join('\n')}\n`;
  const file = writeReport(result.pipeline.graph.root, full, manifest?.runDir ?? null);
  if (options.full) {
    io.stdout.write(full);
    warnIfNotKept(io, file);
    return;
  }

  let next: NextStep | null = null;
  if (options.apply) next = manifest === null ? null : nextAfterRun(outcome.commit);
  else if (plan.rewrites.length > 0) {
    const flags = [
      ...options.keep.flatMap((path) => ['--keep', path]),
      ...scopeWords({ ...options, dir: '.' }),
    ];
    next = nextAfterPlan('dedupe', options.dir, flags, outcome.git, outcome.unfinished);
  }
  const summary = dedupeSummary({
    plan,
    apply: options.apply,
    manifest,
    commit: outcome.commit,
    git: outcome.git,
    notes: outcome.notes,
    file,
    next,
  });
  io.stdout.write(renderSummary(summary, stylesFor(io.stdout, io.env, options)));
}

/** The plan as text, in the shape `optimize` prints its own. */
function planLines(plan: DedupePlan): string[] {
  const lines = ['Plan', ''];
  if (plan.sets.length === 0) {
    lines.push('  No two images hold the same bytes, so there is nothing to do.', '');
    return lines;
  }
  lines.push(`  Keep one copy of each set of identical images: ${count(plan.sets.length, 'set')}`);
  for (const set of plan.sets) lines.push(...setLines(set));

  if (plan.rewrites.length > 0) {
    const references = plan.rewrites.reduce((sum, rewrite) => sum + rewrite.edits.length, 0);
    lines.push(
      `  Update references: ${count(references, 'reference')} in ${count(plan.rewrites.length, 'file')}`,
    );
    for (const rewrite of plan.rewrites) {
      lines.push(`    ${rewrite.file}  ${count(rewrite.edits.length, 'reference')}`);
    }
  }

  const unused = plan.sets.flatMap((set) =>
    set.copies.filter((copy) => copy.unusedAfter).map((copy) => ({ path: copy.path, set })),
  );
  if (unused.length > 0) {
    const bytes = unused.reduce((sum, { set }) => sum + set.bytes, 0);
    lines.push(
      `  Not deleted: ${unused.length} ${unused.length === 1 ? 'copy' : 'copies'} no reference names once this is written, ${formatBytes(bytes)}. Upfly never`,
      `  deletes ${unused.length === 1 ? 'it' : 'them'}; \`upfly audit\` lists ${unused.length === 1 ? 'it' : 'them'} as unused, with ${unused.length === 1 ? 'its size' : 'their sizes'}.`,
      ...unused.map(({ path }) => `    ${path}`),
    );
  }
  lines.push('');
  return lines;
}

const KEPT: Readonly<Record<KeptBecause, string>> = {
  chosen: 'named by --keep',
  'most-used': 'more references use it than any other copy',
  served:
    'as many references use it as another copy, and a folder the site is served from holds it',
  shorter: 'tied on references, and its path is the shortest',
  first: 'tied on references and length, and it comes first in path order',
};

function setLines(set: DedupeSet): string[] {
  const lines = [`    ${set.keep}  ${formatBytes(set.bytes)}, kept: ${KEPT[set.kept]}`];
  for (const copy of set.copies) {
    lines.push(
      copy.references === 0
        ? `      ${copy.path}  no reference names it`
        : `      ${copy.path}  ${movingText(copy.moved, copy.references, 'to the kept copy')}`,
    );
    for (const stay of copy.stays) {
      lines.push(`        ${stay.where}  ${stay.text} stays as written: ${stay.why}`);
    }
  }
  return lines;
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0] ?? message;
}
