/**
 * The git operations `optimize` needs. Every call passes an argument array to `spawnSync`,
 * never a command string, so no path or message is ever read by a shell. Paths and the
 * commit message travel on stdin, which also keeps a run with thousands of files under
 * Windows' limit on the length of a command line.
 */

import { spawnSync } from 'node:child_process';

export type GitState =
  | { readonly kind: 'no-git' }
  | { readonly kind: 'not-a-repository' }
  | { readonly kind: 'repository'; readonly changed: readonly string[] };

/**
 * Whether `root` is inside a git work tree, and which paths under it have changes, untracked
 * files included, relative to `root`.
 *
 * @param root the project directory
 */
export function gitState(root: string): GitState {
  const result = git(root, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--no-renames',
    '--',
    '.',
  ]);
  if (result.missing) return { kind: 'no-git' };
  if (result.status !== 0) return { kind: 'not-a-repository' };
  const changed = result.stdout
    .split('\0')
    .filter((entry) => entry.length > 3)
    .map((entry) => entry.slice(3))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { kind: 'repository', changed };
}

/**
 * Commits exactly `paths`, as they are on disk, and returns the new commit's hash. A path
 * that no longer exists is committed as a deletion.
 *
 * @param root the project directory, inside a git work tree
 * @param paths POSIX paths relative to `root`
 * @param message the commit message
 * @throws when git refuses; the message carries git's own reason
 */
export function commitPaths(root: string, paths: readonly string[], message: string): string {
  const list = `${paths.join('\0')}\0`;
  must(git(root, ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], list), 'add');
  must(git(root, ['commit', '--quiet', '-F', '-'], message), 'commit');
  return must(git(root, ['rev-parse', 'HEAD']), 'rev-parse').stdout.trim();
}

interface GitResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Git itself could not be started. */
  readonly missing: boolean;
}

function git(root: string, args: readonly string[], input?: string): GitResult {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
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
  const reason = result.stderr.trim().split('\n')[0] ?? '';
  throw new Error(`git ${step} failed${reason === '' ? '' : `: ${reason}`}`);
}
