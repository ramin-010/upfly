import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commitPaths, gitState } from './git.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

/** A repository with one commit, and its own identity so the machine's does not matter. */
function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'upfly-git-'));
  roots.push(root);
  git(root, 'init', '--quiet');
  git(root, 'config', 'user.name', 'Upfly Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  for (const [path, text] of Object.entries(files)) write(root, path, text);
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'start');
  return root;
}

describe('gitState', () => {
  it('says when a directory is not in a repository', () => {
    const root = mkdtempSync(join(tmpdir(), 'upfly-git-'));
    roots.push(root);
    // A machine can keep a repository above its temporary folder; git must not look there.
    const ceiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = dirname(root);
    try {
      expect(gitState(root)).toEqual({ kind: 'not-a-repository' });
    } finally {
      if (ceiling === undefined) Reflect.deleteProperty(process.env, 'GIT_CEILING_DIRECTORIES');
      else process.env.GIT_CEILING_DIRECTORIES = ceiling;
    }
  });

  it('lists modified and untracked files, and nothing for a clean tree', () => {
    const root = repository({ 'index.html': 'a', 'img/logo.png': 'b' });
    expect(gitState(root)).toEqual({ kind: 'repository', changed: [] });

    write(root, 'index.html', 'changed');
    write(root, 'img/new.png', 'untracked');
    expect(gitState(root)).toEqual({
      kind: 'repository',
      changed: ['img/new.png', 'index.html'],
    });
  });

  it('does not see a folder that ignores itself, which is how .upfly stays out of the way', () => {
    const root = repository({ 'index.html': 'a' });
    write(root, '.upfly/.gitignore', '*\n');
    write(root, '.upfly/manifest.json', '{}');
    expect(gitState(root)).toEqual({ kind: 'repository', changed: [] });
  });
});

describe('commitPaths', () => {
  it('commits exactly the paths given, additions, edits and deletions, as one commit', () => {
    const root = repository({ 'index.html': 'a', 'img/logo.png': 'b', 'notes.txt': 'c' });
    write(root, 'index.html', '<img src="img/logo.webp">');
    write(root, 'img/logo.webp', 'new');
    rmSync(join(root, 'img/logo.png'));
    write(root, 'notes.txt', 'the user was here');

    const hash = commitPaths(
      root,
      ['img/logo.png', 'img/logo.webp', 'index.html'],
      'Optimize images\n\nOne line with "quotes" and $(no shell)',
    );

    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(hash);
    expect(git(root, 'rev-list', '--count', 'HEAD').trim()).toBe('2');
    expect(git(root, 'log', '-1', '--format=%B').trim()).toBe(
      'Optimize images\n\nOne line with "quotes" and $(no shell)',
    );
    expect(git(root, 'show', '--name-status', '--format=', 'HEAD').trim().split('\n')).toEqual([
      'D\timg/logo.png',
      'A\timg/logo.webp',
      'M\tindex.html',
    ]);
    expect(gitState(root)).toEqual({ kind: 'repository', changed: ['notes.txt'] });
  });

  it('takes a path with spaces and shell characters literally', () => {
    const root = repository({ 'img/a b;$(x).png': 'old' });
    write(root, 'img/a b;$(x).png', 'new');
    commitPaths(root, ['img/a b;$(x).png'], 'one file');
    expect(gitState(root)).toEqual({ kind: 'repository', changed: [] });
  });
});
