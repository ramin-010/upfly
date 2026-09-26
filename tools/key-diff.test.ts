import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { KEY_FILE, compareKeys, referencesInProse } from './key-diff.mjs';

const SCRIPT = fileURLToPath(new URL('./key-diff.mjs', import.meta.url));

type Entry = {
  raw: string;
  occurrence: number;
  shape: string;
  expect: string;
  why: string;
  knownGap?: string;
};
type Key = {
  version: number;
  what: string;
  servingRoots: { path: string; why: string }[];
  shapes: { id: string; label: string; spec: string; motivation: string }[];
  files: { path: string; entries: Entry[] }[];
};

const SHAPE = { id: 'html.img.src', label: 'img@src', spec: '4a', motivation: 'The base case.' };

function key(): Key {
  return {
    version: 1,
    what: 'The answer key (R75).',
    servingRoots: [{ path: 'apps/web/public', why: 'Serving root #1.' }],
    shapes: [{ ...SHAPE }],
    files: [
      {
        path: 'apps/web/index.html',
        entries: [
          { raw: '/a.png', occurrence: 1, shape: SHAPE.id, expect: 'resolved', why: 'R12.' },
          {
            raw: '/b.png',
            occurrence: 1,
            shape: SHAPE.id,
            expect: 'broken',
            why: 'Missing.',
            knownGap: 'R72 / §4j: no adapter reads it.',
          },
        ],
      },
    ],
  };
}

function entry(k: Key, index: number): Entry {
  const found = k.files[0]?.entries[index];
  if (found === undefined) throw new Error(`no entry ${index}`);
  return found;
}

describe('comparing two versions of the key', () => {
  it('passes a change to the prose, and counts it per field', () => {
    const after = key();
    after.what = 'The answer key.';
    entry(after, 0).why = 'An image element, resolved.';
    entry(after, 1).knownGap = 'No adapter reads the file.';
    const { problems, prose } = compareKeys(key(), after);
    expect(problems).toEqual([]);
    expect(prose.map((change) => change.field)).toEqual([
      'what',
      'files.*.entries.*.why',
      'files.*.entries.*.knownGap',
    ]);
  });

  it.each([
    ['an expected outcome', (k: Key) => Object.assign(entry(k, 0), { expect: 'broken' })],
    ['a position', (k: Key) => Object.assign(entry(k, 0), { raw: '/c.png' })],
    [
      'a serving root',
      (k: Key) => Object.assign(k, { servingRoots: [{ path: 'public', why: '' }] }),
    ],
    ['a shape label', (k: Key) => Object.assign(k, { shapes: [{ ...SHAPE, label: 'img' }] })],
    ['a removed known gap', (k: Key) => Reflect.deleteProperty(entry(k, 1), 'knownGap')],
    ['an added known gap', (k: Key) => Object.assign(entry(k, 0), { knownGap: 'new' })],
    ['a removed entry', (k: Key) => k.files[0]?.entries.pop()],
    ['reordered entries', (k: Key) => k.files[0]?.entries.reverse()],
  ])('fails on %s', (_, change) => {
    const after = key();
    change(after);
    expect(compareKeys(key(), after).problems).not.toEqual([]);
  });

  it('counts the internal references left in the prose', () => {
    expect(referencesInProse(key())).toEqual({
      what: 1,
      'files.*.entries.*.why': 1,
      'files.*.entries.*.knownGap': 2,
    });
  });
});

describe('the script itself', () => {
  const repos: string[] = [];
  afterEach(() => {
    for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
  });

  function repository() {
    const repo = mkdtempSync(join(realpathSync.native(tmpdir()), 'upfly-key-diff-'));
    repos.push(repo);
    const identity = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];
    const git = (...args: string[]) =>
      execFileSync('git', [...identity, '-c', 'commit.gpgsign=false', ...args], { cwd: repo });
    git('init', '--quiet');
    git('config', 'core.autocrlf', 'false');
    mkdirSync(dirname(join(repo, KEY_FILE)), { recursive: true });
    writeFileSync(join(repo, KEY_FILE), JSON.stringify(key(), null, 2));
    git('add', '.');
    git('commit', '--quiet', '-m', 'base');
    return repo;
  }

  function run(repo: string) {
    const result = spawnSync(process.execPath, [SCRIPT, '--root', repo], { encoding: 'utf8' });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }

  it('passes reworded prose and fails a changed outcome', () => {
    const repo = repository();
    const reworded = key();
    entry(reworded, 1).knownGap = 'No adapter reads the file.';
    writeFileSync(join(repo, KEY_FILE), JSON.stringify(reworded, null, 2));
    const passed = run(repo);
    expect(passed.status).toBe(0);
    expect(passed.output).toContain('Prose changed: files.*.entries.*.knownGap 1.');
    expect(passed.output).toContain('Internal references in prose: before 4, after 2.');

    entry(reworded, 1).expect = 'resolved';
    writeFileSync(join(repo, KEY_FILE), JSON.stringify(reworded, null, 2));
    const failed = run(repo);
    expect(failed.status).toBe(1);
    expect(failed.output).toContain('files.0.entries.1.expect: "broken" became "resolved"');
  });
});
