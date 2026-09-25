/**
 * The git operations `optimize` and `undo` need. Every call passes an argument array to
 * `spawnSync`, never a command string, so no path or message is ever read by a shell.
 * Paths travel on stdin, which also keeps a run with thousands of files under Windows'
 * limit on the length of a command line, and git reads them literally, so a name holding
 * `*` or `[` never matches a second file.
 */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

export type GitState =
  | { readonly kind: 'no-git' }
  | { readonly kind: 'not-a-repository' }
  | {
      readonly kind: 'repository';
      /** The repository's top folder, as an absolute path in the platform's spelling. */
      readonly top: string;
      /** Where the project sits inside the repository: POSIX, ending in `/`, or empty. */
      readonly prefix: string;
      /** Whether the repository tracks any file under the project. */
      readonly tracked: boolean;
      /** Paths under the project with changes, untracked files included, relative to it. */
      readonly changed: readonly string[];
    };

/** The commit message line that names the run a commit holds, so `undo` can find it. */
export const RUN_TRAILER = 'Upfly-Run';

/**
 * Whether `root` is inside a git work tree and, if so, what git says about the part of it
 * under `root`. Changes elsewhere in the repository are not looked at.
 *
 * @param root the project directory
 * @throws when git fails in a way other than finding no repository
 */
export function gitState(root: string): GitState {
  const where = git(root, ['rev-parse', '--show-toplevel', '--show-prefix']);
  if (where.missing) return { kind: 'no-git' };
  if (where.status !== 0) return { kind: 'not-a-repository' };
  const [top = '', prefix = ''] = where.stdout.split('\n');

  const status = must(
    git(root, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--no-renames',
      '--',
      '.',
    ]),
    'status',
  );
  // Porcelain paths are relative to the repository's top, wherever git runs.
  const changed = status.stdout
    .split('\0')
    .filter((entry) => entry.length > 3)
    .map((entry) => entry.slice(3))
    .map((path) => (path.startsWith(prefix) ? path.slice(prefix.length) : path))
    .sort(compare);
  const tracked = must(git(root, ['ls-files', '-z', '--', '.']), 'ls-files').stdout.length > 0;

  return { kind: 'repository', top: resolve(top), prefix, tracked, changed };
}

/**
 * Which of `paths` git would refuse to add because an ignore rule covers them. A tracked
 * file is never among them: ignore rules do not apply to it.
 *
 * @param root the project directory, inside a git work tree
 * @param paths POSIX paths relative to `root`, which need not exist yet
 * @throws when git refuses; the message carries git's own reason
 */
export function ignoredPaths(root: string, paths: readonly string[]): string[] {
  if (paths.length === 0) return [];
  // `check-ignore` takes plain paths and rejects the literal-pathspec setting.
  const result = git(root, ['check-ignore', '--stdin', '-z'], nulList(paths), false);
  // Exit 1 is git's answer "none of them".
  if (result.status === 1) return [];
  return must(result, 'check-ignore')
    .stdout.split('\0')
    .filter((path) => path !== '')
    .sort(compare);
}

/**
 * Why git cannot make a commit here, in git's own first line, or null when it knows a name
 * and an email to commit as.
 *
 * @param root the project directory, inside a git work tree
 */
export function identityProblem(root: string): string | null {
  for (const variable of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
    const result = git(root, ['var', variable]);
    if (result.status !== 0) return firstLine(result.stderr) || `git var ${variable} failed`;
  }
  return null;
}

/**
 * Commits exactly `paths`, as they are on disk, and returns the new commit's hash. A path
 * that no longer exists is committed as a deletion. Changes staged for any other path stay
 * staged and out of the commit.
 *
 * @param root the project directory, inside a git work tree
 * @param paths POSIX paths relative to `root`
 * @param message the commit message
 * @throws when git refuses; the message carries git's own reason
 */
export function commitPaths(root: string, paths: readonly string[], message: string): string {
  const list = nulList(paths);
  // A new file must be in the index before a commit limited to named paths can take it.
  must(git(root, ['add', '--pathspec-from-file=-', '--pathspec-file-nul'], list), 'add');
  must(
    git(
      root,
      [
        'commit',
        '--quiet',
        '--only',
        '--pathspec-from-file=-',
        '--pathspec-file-nul',
        '-m',
        message,
      ],
      list,
    ),
    'commit',
  );
  return must(git(root, ['rev-parse', 'HEAD']), 'rev-parse').stdout.trim();
}

/**
 * The newest commit whose message names the run `runId` on a `Upfly-Run:` line, or null
 * when there is none or no history to search.
 *
 * @param root the project directory
 * @param runId the run to look for
 */
export function commitForRun(root: string, runId: string): string | null {
  const result = git(root, [
    'log',
    '-n',
    '1',
    '--format=%H',
    '-F',
    `--grep=${RUN_TRAILER}: ${runId}`,
  ]);
  if (result.status !== 0) return null;
  const hash = result.stdout.trim();
  return hash === '' ? null : hash;
}

interface GitResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Git itself could not be started. */
  readonly missing: boolean;
}

function git(root: string, args: readonly string[], input?: string, literal = true): GitResult {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: literal ? { ...process.env, GIT_LITERAL_PATHSPECS: '1' } : process.env,
    ...(input === undefined ? {} : { input }),
    maxBuffer: 256 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    missing:
      result.error !== undefined && (result.error as NodeJS.ErrnoException).code === 'ENOENT',
  };
}

function must(result: GitResult, step: string): GitResult {
  if (result.status === 0) return result;
  const reason = firstLine(result.stderr);
  throw new Error(`git ${step} failed${reason === '' ? '' : `: ${reason}`}`);
}

function nulList(paths: readonly string[]): string {
  return `${paths.join('\0')}\0`;
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? '';
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
