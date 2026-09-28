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

describe('files moved between folders', () => {
  const repos: string[] = [];
  afterEach(() => {
    for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
  });

  // Long enough that git pairs each moved file with its old self after its imports change.
  const BODY = ['', '/** One. */', 'export const one = 1;', '/** Two. */', 'export const two = 2;'];

  /** A repository whose `src/a.ts` and its test are named by imports, paths and a note. */
  function repository() {
    const repo = mkdtempSync(join(realpathSync.native(tmpdir()), 'upfly-move-diff-'));
    repos.push(repo);
    const files: Record<string, string[]> = {
      'src/a.ts': ["import { b } from './b.js';", ...BODY, 'export const a = b + 1;'],
      'src/b.ts': ['export const b = 1;'],
      'src/c.ts': [
        '/** The module doc. */',
        '',
        "import { a } from './a.js';",
        "import { b } from './b.js';",
        '',
        '// Keep this comment.',
        'export const c = a + b;',
      ],
      'src/a.test.ts': [
        "import { join } from 'node:path';",
        "import { a } from './a.js';",
        ...BODY,
        "export const FIXTURES = join(import.meta.dirname, '../fixtures');",
        "export const KEY = join(import.meta.dirname, '..', 'data', 'key.json');",
        'export const value = a;',
      ],
      'tools/load.mjs': [
        "import { join } from 'node:path';",
        "export const BUILT = join(import.meta.dirname, '..', 'dist', 'a.js');",
        "export const SOURCE = 'src/a.ts';",
      ],
      'notes.md': ['See src/a.ts and src/b.ts.'],
      'fixtures/x.txt': ['x'],
      'data/key.json': ['{}'],
    };
    for (const [file, lines] of Object.entries(files)) write(repo, file, `${lines.join('\n')}\n`);
    git(repo, 'init', '--quiet');
    git(repo, 'config', 'core.autocrlf', 'false');
    git(repo, 'add', '--', '.');
    git(repo, 'commit', '--quiet', '-m', 'base');
    return repo;
  }

  function write(repo: string, file: string, content: string) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), content);
  }

  function git(repo: string, ...args: string[]) {
    const identity = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];
    return execFileSync('git', [...identity, '-c', 'commit.gpgsign=false', ...args], {
      cwd: repo,
    });
  }

  function edit(repo: string, file: string, from: string, to: string) {
    const target = join(repo, file);
    const text = readFileSync(target, 'utf8');
    if (!text.includes(from)) throw new Error(`${file} does not hold ${from}`);
    writeFileSync(target, text.replace(from, to));
    git(repo, 'add', '--', file);
  }

  /** `src/a.ts` and its test move to `src/stage/`, and every path that names them follows. */
  function move(repo: string, name = 'a') {
    mkdirSync(join(repo, 'src/stage'));
    renameSync(join(repo, 'src/a.ts'), join(repo, `src/stage/${name}.ts`));
    renameSync(join(repo, 'src/a.test.ts'), join(repo, `src/stage/${name}.test.ts`));
    git(repo, 'add', '--', 'src/a.ts', 'src/a.test.ts', 'src/stage');
    edit(repo, `src/stage/${name}.ts`, "'./b.js'", "'../b.js'");
    edit(repo, `src/stage/${name}.test.ts`, "'./a.js'", `'./${name}.js'`);
    edit(repo, `src/stage/${name}.test.ts`, "'../fixtures'", "'../../fixtures'");
    edit(repo, `src/stage/${name}.test.ts`, "'..', 'data'", "'..', '..', 'data'");
    // The formatter orders imports by path, so the moved one now comes second.
    edit(
      repo,
      'src/c.ts',
      "import { a } from './a.js';\nimport { b } from './b.js';",
      `import { b } from './b.js';\nimport { a } from './stage/${name}.js';`,
    );
    edit(repo, 'tools/load.mjs', "'dist', 'a.js'", `'dist', 'stage', '${name}.js'`);
    edit(repo, 'tools/load.mjs', "'src/a.ts'", `'src/stage/${name}.ts'`);
    edit(repo, 'notes.md', 'src/a.ts', `src/stage/${name}.ts`);
  }

  function run(repo: string, ...extra: string[]) {
    const moves = [
      '--move',
      'src/a.ts=src/stage/a.ts',
      '--move',
      'src/a.test.ts=src/stage/a.test.ts',
    ];
    const args = [SCRIPT, '--root', repo, ...moves, '--mirror', 'src=dist', ...extra];
    const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }

  it('passes the move and every path that follows it, and counts what it explained', () => {
    const repo = repository();
    move(repo);
    const result = run(repo, '--keep-names');
    expect(result.output).toContain(
      'Moved: 2 files, 2 renames git sees, 2 keep their names, 0 of 2 identical.',
    );
    expect(result.output).toContain('Other changed files: 3.');
    expect(result.output).toContain(
      'Paths changed that reach the same place: 2 in imports, 4 elsewhere. Import runs ' +
        're-sorted: 1. Lines of text with a moved path: 1.',
    );
    expect(result.status).toBe(0);
  });

  it('reads a committed move with --base and --head', () => {
    const repo = repository();
    move(repo);
    git(repo, 'commit', '--quiet', '-m', 'move');
    expect(run(repo, '--base', 'HEAD~1', '--head', 'HEAD').status).toBe(0);
  });

  it('fails a planted code change in a moved file, and prints where', () => {
    const repo = repository();
    move(repo);
    edit(repo, 'src/stage/a.ts', 'b + 1', 'b + 2');
    const result = run(repo);
    expect(result.status).toBe(1);
    expect(result.output).toContain('src/stage/a.ts:7');
  });

  it('fails an import that now reaches another file', () => {
    const repo = repository();
    move(repo);
    edit(repo, 'src/c.ts', "import { a } from './stage/a.js';", "import { a } from './b.js';");
    expect(run(repo).status).toBe(1);
  });

  it('fails a relative path that reaches another folder from where its file now is', () => {
    const repo = repository();
    move(repo);
    edit(repo, 'src/stage/a.test.ts', "'../../fixtures'", "'../fixtures/'");
    expect(run(repo).output).toContain('src/stage/a.test.ts:');
  });

  it('fails a changed comment, which a move never needs', () => {
    const repo = repository();
    move(repo);
    edit(repo, 'src/c.ts', '// Keep this comment.', '// Keep this one.');
    expect(run(repo).status).toBe(1);
  });

  it('fails statements put in another order outside a run of imports', () => {
    const repo = repository();
    move(repo);
    edit(repo, 'src/stage/a.ts', '/** One. */\nexport const one = 1;\n', '');
    edit(
      repo,
      'src/stage/a.ts',
      'export const two = 2;\n',
      'export const two = 2;\n/** One. */\nexport const one = 1;\n',
    );
    expect(run(repo).status).toBe(1);
  });

  it('fails a path in text that the moves do not change', () => {
    const repo = repository();
    move(repo);
    edit(repo, 'notes.md', 'src/b.ts', 'src/stage/b.ts');
    expect(run(repo).output).toContain('notes.md:1');
  });

  it('fails a move that renames the file, under --keep-names', () => {
    const repo = repository();
    move(repo, 'a2');
    const args = [SCRIPT, '--root', repo, '--keep-names', '--mirror', 'src=dist'];
    const moves = [
      '--move',
      'src/a.ts=src/stage/a2.ts',
      '--move',
      'src/a.test.ts=src/stage/a2.test.ts',
    ];
    const result = spawnSync(process.execPath, [...args, ...moves], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('renamed: src/a.ts -> src/stage/a2.ts');
  });

  it('fails a declared move that git does not see', () => {
    const repo = repository();
    move(repo);
    const result = run(repo, '--move', 'src/b.ts=src/stage/b.ts');
    expect(result.status).toBe(1);
    expect(result.output).toContain('git does not see a rename: src/b.ts -> src/stage/b.ts');
  });

  it('exits 2 for a move not written as <old>=<new>', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--move', 'src/a.ts'], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--move takes <old>=<new>');
  });
});
