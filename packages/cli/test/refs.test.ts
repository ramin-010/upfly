/**
 * `upfly refs` through the built binary, on copies of the plain HTML fixture outside the
 * workspace: every reference to one image, whether each can be rewritten, and what `optimize`
 * would do with the image.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BIN,
  FIXTURES,
  copyFixture,
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

const LOGO = readFileSync(join(FIXTURES, 'plain-html/images/logo.png'));

/** The plain HTML site, with a download link to the logo and a folder only a template reaches. */
function site(): string {
  const root = copyFixture('plain-html', tempFolder(roots, 'upfly-refs-'));
  write(root, 'notes.md', '[the logo, as a download](images/logo.png)\n');
  write(root, 'app.js', 'export const icon = (name) => `images/icons/${name}.png`;\n');
  write(root, 'images/icons/star.png', LOGO);
  return root;
}

function result(stdout: string): Record<string, unknown> {
  return jsonLines(stdout).at(-1) ?? {};
}

describe('upfly refs', () => {
  it('lists every reference, says which stays as written and why, and gives the verdict', () => {
    const root = site();
    const before = snapshot(root);

    const run = upfly(['refs', join(root, 'images/logo.png'), root]);

    expect(run.status).toBe(0);
    const lines = run.stdout.split('\n');
    expect(lines.slice(0, 5)).toEqual([
      'images/logo.png  7.2 KB',
      '',
      'References (2)',
      '    index.html:10  images/logo.png',
      '    notes.md:1  images/logo.png',
    ]);
    expect(lines[5]).toMatch(/^ {6}stays as written: .+/);
    expect(run.stdout).toContain(
      'Verdict: converts to images/logo.webp, 7.2 KB to 850 B. 1 of its 2 references moves to the new file; the original stays beside it.',
    );
    expect(snapshot(root)).toEqual(before);
  });

  it('answers under --json with a small object: the image, each reference, the verdict', () => {
    const root = site();

    const run = upfly(['refs', join(root, 'images/logo.png'), root, '--json']);

    expect(run.status).toBe(0);
    expect(result(run.stdout)).toEqual({
      type: 'result',
      command: 'refs',
      exitCode: 0,
      image: 'images/logo.png',
      bytes: LOGO.length,
      references: [
        { file: 'index.html', line: 10, text: 'images/logo.png', rewritable: true },
        {
          file: 'notes.md',
          line: 1,
          text: 'images/logo.png',
          rewritable: false,
          why: expect.any(String),
        },
      ],
      verdict: {
        kind: 'converts',
        to: 'images/logo.webp',
        savedBytes: expect.any(Number),
        removesOriginal: false,
      },
    });
  });

  it('reads the image path from the current folder, and the project from it by default', () => {
    const root = site();

    const run = upfly(['refs', 'images/logo.png'], { cwd: root });

    expect(run.status).toBe(0);
    expect(run.stdout.split('\n')[0]).toBe('images/logo.png  7.2 KB');
  });

  it('says an image nothing names is unused, and that Upfly leaves it where it is', () => {
    const root = site();

    const run = upfly(['refs', join(root, 'images/never-referenced.png'), root]);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('No reference Upfly can read reaches it.');
    expect(run.stdout).toContain(
      'Verdict: unused. Nothing names it, not even by file name in a file Upfly could not read; Upfly never deletes an image, and `upfly audit` lists it with its size.',
    );
  });

  it('says where the name of a possibly unused image appears', () => {
    const root = site();

    const run = upfly(['refs', join(root, 'images/removed.png'), root, '--json']);

    expect(result(run.stdout)).toMatchObject({
      references: [],
      verdict: {
        kind: 'possibly-unused',
        mentions: [expect.objectContaining({ where: 'index.html:17' })],
      },
    });
  });

  it('gives the reason an image only a template reaches is not converted', () => {
    const root = site();

    const run = upfly(['refs', join(root, 'images/icons/star.png'), root, '--json']);
    const answer = result(run.stdout) as {
      references: { rewritable: boolean; why: string }[];
      verdict: { kind: string; why: string };
    };

    expect(answer.references).toEqual([
      expect.objectContaining({
        file: 'app.js',
        rewritable: false,
        why: 'a template reference is assembled at runtime, so its text cannot be repointed',
      }),
    ]);
    expect(answer.verdict.kind).toBe('not-converted');
    expect(answer.verdict.why).toContain(
      'Upfly converts an image only when a reference moves to the new file',
    );
  });

  it('exits 2 with a plain message for no such file, a file outside the project, and a page', () => {
    const root = site();
    const elsewhere = tempFolder(roots, 'upfly-refs-elsewhere-');
    write(elsewhere, 'outside.png', LOGO);

    const missing = upfly(['refs', join(root, 'images/nope.png'), root]);
    const outside = upfly(['refs', join(elsewhere, 'outside.png'), root]);
    const page = upfly(['refs', join(root, 'index.html'), root]);
    const none = upfly(['refs']);

    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('there is no file at');
    expect(outside.status).toBe(2);
    expect(outside.stderr).toContain('is outside the project');
    expect(page.status).toBe(2);
    expect(page.stderr).toContain('index.html is not an image Upfly found in the project');
    expect(none.status).toBe(2);
    expect(none.stderr).toContain('refs needs the path of an image');
  });
});
