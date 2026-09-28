import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { explains } from './rename-diff.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'rename-diff.mjs');

describe('which changed lines the rename explains', () => {
  it('takes the old name where it is a whole path segment', () => {
    expect(explains("'old-name/x.json'", "'new-name/x.json'", 'old-name', 'new-name')).toBe(true);
    expect(explains("'../old-name'", "'../new-name'", 'old-name', 'new-name')).toBe(true);
    expect(
      explains(
        'run: node old-name/tools/a.mjs',
        'run: node new-name/tools/a.mjs',
        'old-name',
        'new-name',
      ),
    ).toBe(true);
  });

  it('leaves a script name and a longer file name alone', () => {
    expect(explains('pnpm old-name:check', 'pnpm new-name:check', 'old-name', 'new-name')).toBe(
      false,
    );
    expect(
      explains('notes/10-old-name-spec.md', 'notes/10-new-name-spec.md', 'old-name', 'new-name'),
    ).toBe(false);
  });

  it('refuses any other difference on the line', () => {
    expect(
      explains(
        "'old-name/x.json'; const a = 1",
        "'new-name/x.json'; const a = 2",
        'old-name',
        'new-name',
      ),
    ).toBe(false);
  });
});

describe('the script itself', () => {
  const repos: string[] = [];
  afterEach(() => {
    for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
  });

  /** A repository with `old-name/` holding code, data and an image, and one file that names it. */
  function repository() {
    const repo = mkdtempSync(join(realpathSync.native(tmpdir()), 'upfly-rename-diff-'));
    repos.push(repo);
    const write = (file: string, content: string | Buffer) => {
      mkdirSync(dirname(join(repo, file)), { recursive: true });
      writeFileSync(join(repo, file), content);
    };
    write('old-name/tools/answer.mjs', 'export const answer = 1;\n');
    write('old-name/key/key.json', '{ "entries": 3 }\n');
    write('old-name/tree/img/a.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    write('old-name/tree/img/b.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    write('scripts/load.mjs', "import key from '../old-name/key/key.json';\nexport default key;\n");
    write('notes.md', 'See notes/10-old-name-spec.md.\n');
    git(repo, 'init', '--quiet');
    git(repo, 'config', 'core.autocrlf', 'false');
    git(repo, 'add', '--', '.');
    git(repo, 'commit', '--quiet', '-m', 'base');
    return repo;
  }

  function git(repo: string, ...args: string[]) {
    const identity = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];
    return execFileSync('git', [...identity, '-c', 'commit.gpgsign=false', ...args], {
      cwd: repo,
    });
  }

  /** The move itself, then the reference outside it, both staged. */
  function move(repo: string) {
    renameSync(join(repo, 'old-name'), join(repo, 'new-name'));
    const load = join(repo, 'scripts/load.mjs');
    writeFileSync(load, readFileSync(load, 'utf8').replace('../old-name/', '../new-name/'));
    git(repo, 'add', '--', 'old-name', 'new-name', 'scripts/load.mjs');
  }

  function edit(repo: string, file: string, from: string | RegExp, to: string) {
    const target = join(repo, file);
    writeFileSync(target, readFileSync(target, 'utf8').replace(from, to));
    git(repo, 'add', '--', file);
  }

  function run(repo: string, ...extra: string[]) {
    const args = [SCRIPT, '--root', repo, '--from', 'old-name', '--to', 'new-name', ...extra];
    const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }

  it('passes a folder moved unchanged, and counts what it checked', () => {
    const repo = repository();
    move(repo);
    const result = run(repo);
    expect(result.output).toContain('Moved: 4 files, 4 renames git sees, 4 of 4 identical.');
    expect(result.output).toContain('Other changed files: 1, with 1 changed lines');
    expect(result.status).toBe(0);
  });

  it('reads a committed move with --base and --head', () => {
    const repo = repository();
    move(repo);
    git(repo, 'commit', '--quiet', '-m', 'move');
    expect(run(repo, '--base', 'HEAD~1', '--head', 'HEAD').status).toBe(0);
  });

  it('fails a planted code change in a moved file, and prints the line', () => {
    const repo = repository();
    move(repo);
    edit(repo, 'new-name/tools/answer.mjs', 'answer = 1', 'answer = 2');
    const result = run(repo);
    expect(result.status).toBe(1);
    expect(result.output).toContain('new-name/tools/answer.mjs:1');
    expect(result.output).toContain('- export const answer = 1;');
    expect(result.output).toContain('+ export const answer = 2;');
  });

  it('fails the same change in a file outside the folder', () => {
    const repo = repository();
    move(repo);
    edit(repo, 'scripts/load.mjs', 'export default key;', 'export default { ...key };');
    const result = run(repo);
    expect(result.status).toBe(1);
    expect(result.output).toContain('scripts/load.mjs:2');
  });

  it('fails the name changed inside a longer file name', () => {
    const repo = repository();
    move(repo);
    edit(repo, 'notes.md', '10-old-name-spec', '10-new-name-spec');
    const result = run(repo);
    expect(result.status).toBe(1);
    expect(result.output).toContain('notes.md:1');
  });

  it('fails a moved file that gains a line', () => {
    const repo = repository();
    move(repo);
    edit(repo, 'new-name/key/key.json', /\n$/, '\n\n');
    const result = run(repo);
    expect(result.status).toBe(1);
    expect(result.output).toContain('new-name/key/key.json: 2 lines became 3');
  });

  it('fails an old file deleted with no counterpart in the new folder', () => {
    const repo = repository();
    move(repo);
    git(repo, 'rm', '--quiet', '--cached', '--', 'new-name/key/key.json');
    const result = run(repo);
    expect(result.status).toBe(1);
    expect(result.output).toContain('not in new-name: old-name/key/key.json');
  });

  it('fails one byte changed in a moved image', () => {
    const repo = repository();
    move(repo);
    writeFileSync(
      join(repo, 'new-name/tree/img/a.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 4]),
    );
    git(repo, 'add', '--', 'new-name/tree/img/a.png');
    const result = run(repo);
    expect(result.status).toBe(1);
    expect(result.output).toContain('new-name/tree/img/a.png: a binary file changed');
  });

  it('exits 2 without the folder names', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--to', 'new-name'], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--from and --to are both needed');
  });
});
