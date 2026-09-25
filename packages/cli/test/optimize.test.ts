/**
 * `upfly optimize` through the built binary, on copies of the plain HTML fixture outside
 * the workspace: the dry run, applied runs in a repository of their own and inside a larger
 * one under both policies, and each refusal.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BIN,
  FIXTURES,
  NO_NETWORK,
  commitAll,
  copyFixture,
  git,
  jsonLines,
  snapshot,
  tempFolder,
  upfly,
  write,
} from './helpers.js';

beforeAll(() => {
  expect(existsSync(BIN), `${BIN} is missing; run pnpm build first`).toBe(true);
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Upfly's own folder and git's, left out when comparing a project's files. */
const NOT_THE_PROJECT = ['.git', '.upfly'];

/** Run with --replace, originals are only removed from a folder the site is served from. */
const POLICIES = [
  ['keep-original', []],
  ['replace', ['--replace', '--public', '.']],
] as const;

/** A copy of the plain HTML site, committed in a repository of its own. */
function standalone(): string {
  const root = copyFixture('plain-html', tempFolder(roots, 'upfly-optimize-'));
  commitAll(root);
  return root;
}

/** The same site as `site/` in a larger repository that holds other work too. */
function nested(): { readonly outer: string; readonly site: string } {
  const outer = tempFolder(roots, 'upfly-outer-');
  write(outer, 'notes.txt', 'the rest of the repository\n');
  copyFixture('plain-html', join(outer, 'site'));
  commitAll(outer);
  return { outer, site: join(outer, 'site') };
}

function result(stdout: string): Record<string, unknown> {
  return jsonLines(stdout).at(-1) ?? {};
}

function committedFiles(root: string): string[] {
  return git(root, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort();
}

describe('upfly optimize without --apply', () => {
  it('shows the plan and writes nothing, not even its own folder', () => {
    const root = standalone();
    const before = snapshot(root, ['.git']);

    const run = upfly(['optimize', root]);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Upfly audit');
    expect(run.stdout).toContain('Convert to WebP:');
    expect(run.stdout).toContain('Dry run: nothing was written.');
    expect(snapshot(root, ['.git'])).toEqual(before);
  });

  it('prints each stage as a JSON line, then the plan, which names no run and no commit', () => {
    const root = standalone();

    const run = upfly(['optimize', root, '--json']);
    const lines = jsonLines(run.stdout);

    expect(run.status).toBe(0);
    expect(lines.slice(0, -1).map((line) => line.stage)).toEqual([
      'discovered',
      'scanned',
      'resolved',
      'measured',
      'audited',
      'planned',
    ]);
    expect(lines.at(-1)).toMatchObject({
      type: 'result',
      command: 'optimize',
      exitCode: 0,
      apply: false,
      run: null,
      commit: null,
      repository: { path: '' },
    });
    expect((lines.at(-1)?.plan as { conversions: unknown[] }).conversions.length).toBeGreaterThan(
      0,
    );
  });
});

describe.each(POLICIES)('upfly optimize --apply --commit, %s', (policy, flags) => {
  it('makes one commit of exactly the files it wrote, finds nothing to do the second time, and git revert restores every byte', () => {
    const root = standalone();
    const original = snapshot(root, NOT_THE_PROJECT);

    const first = upfly(['optimize', root, '--apply', '--commit', '--json', ...flags]);
    expect(first.status, first.stderr).toBe(0);
    const applied = result(first.stdout) as {
      run: { created: string[]; changed: string[]; removed: string[] };
      commit: string;
    };

    expect(git(root, 'rev-list', '--count', 'HEAD').trim()).toBe('2');
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(applied.commit);
    expect(committedFiles(root)).toEqual(
      [...applied.run.created, ...applied.run.changed, ...applied.run.removed].sort(),
    );
    // Clean afterwards: the run's own folder is hidden from git by the .gitignore it wrote.
    expect(git(root, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(root, '.upfly/.gitignore'), 'utf8')).toBe('*\n');
    if (policy === 'replace') expect(applied.run.removed.length).toBeGreaterThan(0);
    else expect(applied.run.removed).toEqual([]);
    // The fixture's one broken reference is there on purpose, and nothing may join it.
    const audit = upfly(['audit', root, '--json', '--no-probe', ...flags.slice(1)]);
    const findings = (result(audit.stdout).report as { findings: Record<string, string>[] })
      .findings;
    expect(findings.filter((f) => f.kind === 'broken').map((f) => f.rawPath)).toEqual([
      'images/missing-on-purpose.png',
    ]);

    const afterFirst = snapshot(root, NOT_THE_PROJECT);
    const second = upfly(['optimize', root, '--apply', '--json', ...flags]);
    expect(second.status, second.stderr).toBe(0);
    expect(result(second.stdout)).toMatchObject({ run: null, commit: null });
    expect(git(root, 'rev-list', '--count', 'HEAD').trim()).toBe('2');
    expect(snapshot(root, NOT_THE_PROJECT)).toEqual(afterFirst);

    git(root, 'revert', '--no-edit', 'HEAD');
    expect(snapshot(root, NOT_THE_PROJECT)).toEqual(original);
  }, 120_000);
});

describe('upfly optimize in a project inside a larger repository', () => {
  it('checks and commits only the project, leaves the rest of the repository alone, and names it', () => {
    const { outer, site } = nested();
    write(outer, 'notes.txt', 'changed outside the project, and staged\n');
    git(outer, 'add', 'notes.txt');
    write(outer, 'draft.md', 'untracked, outside the project\n');

    const dry = upfly(['optimize', site]);
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toContain(`This folder is site/ in the git repository at ${outer}.`);

    const applied = upfly(['optimize', site, '--apply', '--commit']);
    expect(applied.status, applied.stderr).toBe(0);
    expect(applied.stdout).toContain(
      `The commit is in the git repository at ${outer}, and holds only files under site/.`,
    );
    const files = committedFiles(outer);
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((file) => file.startsWith('site/'))).toBe(true);
    expect(git(outer, 'diff', '--cached', '--name-only').trim()).toBe('notes.txt');
    expect(git(outer, 'status', '--porcelain', '--', 'draft.md').trim()).toBe('?? draft.md');
  }, 120_000);

  it('refuses when the project itself has uncommitted changes, naming the file and the repository', () => {
    const { outer, site } = nested();
    write(site, 'about.html', '<p>edited by hand</p>\n');
    const before = snapshot(site);

    const run = upfly(['optimize', site, '--apply']);

    expect(run.status).toBe(3);
    expect(run.stderr).toContain('Uncommitted changes in 1 file under this folder');
    expect(run.stderr).toContain(`in the git repository at ${outer}, where this folder is site/`);
    expect(run.stderr).toContain('about.html');
    expect(snapshot(site)).toEqual(before);
  });
});

describe('upfly optimize refuses to write, with exit 3 and what to do', () => {
  it('while the project has uncommitted changes, unless --allow-dirty', () => {
    const root = standalone();
    write(root, 'about.html', '<p>edited by hand</p>\n');
    const before = snapshot(root, ['.git']);

    const refused = upfly(['optimize', root, '--apply', '--json']);
    expect(refused.status).toBe(3);
    expect(result(refused.stdout)).toMatchObject({
      type: 'error',
      exitCode: 3,
      reason: 'UNCOMMITTED_CHANGES',
      message: expect.stringContaining('about.html'),
    });
    expect(snapshot(root, ['.git'])).toEqual(before);

    const allowed = upfly(['optimize', root, '--apply', '--allow-dirty']);
    expect(allowed.status, allowed.stderr).toBe(0);
    expect(existsSync(join(root, 'images/logo.webp'))).toBe(true);
  });

  it('for an untracked file alone, which git could not restore if the run removed it', () => {
    const root = standalone();
    write(root, 'images/new.png', readFileSync(join(root, 'images/logo.png')));

    const run = upfly(['optimize', root, '--apply', '--replace', '--public', '.', '--json']);

    expect(run.status).toBe(3);
    expect(result(run.stdout)).toMatchObject({
      reason: 'UNCOMMITTED_CHANGES',
      message: expect.stringContaining('images/new.png'),
    });
    expect(existsSync(join(root, '.upfly'))).toBe(false);
  });

  it('outside a repository, unless --allow-dirty; and --commit there is a usage error', () => {
    const root = copyFixture('plain-html', tempFolder(roots, 'upfly-no-git-'));
    const before = snapshot(root);

    const refused = upfly(['optimize', root, '--apply', '--json']);
    const commit = upfly(['optimize', root, '--apply', '--commit']);
    expect(refused.status).toBe(3);
    expect(result(refused.stdout)).toMatchObject({ reason: 'NO_REPOSITORY' });
    expect(commit.status).toBe(2);
    expect(commit.stderr).toContain('--commit needs a git repository');
    expect(snapshot(root)).toEqual(before);

    const allowed = upfly(['optimize', root, '--apply', '--allow-dirty']);
    expect(allowed.status, allowed.stderr).toBe(0);
    expect(existsSync(join(root, 'images/logo.webp'))).toBe(true);
  });

  it('while another run holds the project, and after a run that stopped part way', () => {
    const root = standalone();
    const before = snapshot(root, NOT_THE_PROJECT);
    // This test's own process is alive, so to the binary it is another run.
    const holder = { pid: process.pid, startedAt: '2026-09-26T00:00:00.000Z', runId: 'run-other' };
    write(root, '.upfly/lock', `${JSON.stringify(holder)}\n`);

    const locked = upfly(['optimize', root, '--apply', '--json']);
    expect(locked.status).toBe(3);
    expect(result(locked.stdout)).toMatchObject({
      reason: 'TRANSACTION_LOCKED',
      message: expect.stringContaining('run-other'),
    });

    rmSync(join(root, '.upfly/lock'));
    write(
      root,
      '.upfly/manifest.json',
      `${JSON.stringify({
        schemaVersion: 1,
        hashAlgorithm: 'sha256',
        runId: 'run-stopped',
        startedAt: '2026-09-26T00:00:00.000Z',
        completedAt: null,
        revertedAt: null,
        state: 'pending',
        runDir: '.upfly/runs/run-stopped',
        operations: [],
        declined: [],
      })}\n`,
    );
    const interrupted = upfly(['optimize', root, '--apply', '--json']);
    expect(interrupted.status).toBe(3);
    expect(result(interrupted.stdout)).toMatchObject({
      reason: 'TRANSACTION_INTERRUPTED',
      message: expect.stringContaining('upfly undo'),
    });
    expect(snapshot(root, NOT_THE_PROJECT)).toEqual(before);
  });

  it('when most root-relative references point nowhere, so the served folder is unknown', () => {
    const root = tempFolder(roots, 'upfly-unknown-root-');
    const missing = Array.from({ length: 10 }, (_, n) => `<img src="/pictures/missing-${n}.png">`);
    write(root, 'index.html', `${missing.join('\n')}\n<img src="logo.png">\n`);
    write(root, 'logo.png', readFileSync(join(FIXTURES, 'plain-html/images/logo.png')));

    const run = upfly(['optimize', root, '--json']);

    expect(run.status).toBe(3);
    expect(result(run.stdout)).toMatchObject({
      reason: 'SERVING_ROOT_UNKNOWN',
      message: expect.stringContaining('--public <dir>'),
    });
  });

  it('with --commit, before writing anything, when git ignores a file the run would write', () => {
    const root = copyFixture('plain-html', tempFolder(roots, 'upfly-ignored-'));
    write(root, '.gitignore', '*.webp\n');
    commitAll(root);
    const before = snapshot(root, ['.git']);

    const run = upfly(['optimize', root, '--apply', '--commit', '--json']);

    expect(run.status).toBe(3);
    expect(result(run.stdout)).toMatchObject({
      reason: 'IGNORED_BY_GIT',
      message: expect.stringContaining('this run would write: images/badge.webp'),
    });
    expect(snapshot(root, ['.git'])).toEqual(before);
  });
});

describe('upfly optimize and the network', () => {
  it('opens no connection and resolves no name while it writes and commits', () => {
    const root = standalone();
    const log = join(tempFolder(roots, 'upfly-net-'), 'attempts.log');

    const run = upfly(['optimize', root, '--apply', '--commit'], {
      env: { UPFLY_NETWORK_LOG: log },
      preload: NO_NETWORK,
    });

    expect(run.status, run.stderr).toBe(0);
    expect(existsSync(log)).toBe(false);
  });
});
