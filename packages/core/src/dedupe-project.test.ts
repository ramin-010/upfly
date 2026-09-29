import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { dedupeProject } from './dedupe-project.js';
import { createNodeFileStore } from './write/file-store-node.js';
import { revert } from './write/transaction.js';

const LOGO = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/plain-html/images/logo.png',
);

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A project outside the workspace, with the same image stored more than once. */
async function project(files: Record<string, string | 'LOGO'>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'upfly-dedupe-'));
  roots.push(root);
  const logo = await readFile(LOGO);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content === 'LOGO' ? logo : content);
  }
  return root;
}

/** Two copies of one image: the copy two pages use, and the one a single page uses. */
const TWO_COPIES = {
  'index.html': '<img src="img/logo.png">\n<img src="img/logo-copy.png">\n',
  'about/index.html': '<img src="../img/logo-copy.png">\n',
  'img/logo.png': 'LOGO',
  'img/logo-copy.png': 'LOGO',
} as const;

describe('dedupeProject', () => {
  it('keeps the copy most references use and points every other reference at it', async () => {
    const root = await project(TWO_COPIES);

    const { plan, manifest } = await dedupeProject({ root, apply: false });

    expect(manifest).toBeNull();
    expect(plan.sets).toEqual([
      expect.objectContaining({
        keep: 'img/logo-copy.png',
        kept: 'most-used',
        copies: [
          expect.objectContaining({
            path: 'img/logo.png',
            references: 1,
            moved: 1,
            stays: [],
            unusedAfter: true,
          }),
        ],
      }),
    ]);
    expect(plan.rewrites).toEqual([
      {
        file: 'index.html',
        edits: [expect.objectContaining({ replacement: 'img/logo-copy.png' })],
        textHash: expect.any(String),
      },
    ]);
  });

  it('keeps the copy it is told to, and re-derives each path from the file that holds it', async () => {
    const root = await project(TWO_COPIES);

    const { plan } = await dedupeProject({ root, apply: false, keep: ['img/logo.png'] });

    expect(plan.sets[0]).toMatchObject({ keep: 'img/logo.png', kept: 'chosen' });
    expect(
      plan.rewrites.map((rewrite) => [rewrite.file, rewrite.edits.map((e) => e.replacement)]),
    ).toEqual([
      ['about/index.html', ['../img/logo.png']],
      ['index.html', ['img/logo.png']],
    ]);
  });

  it('leaves a reference that cannot load the kept copy the way it loads files, and says why', async () => {
    // A tie on references goes to the copy a website folder serves; an import then cannot
    // name it, since bundlers such as Vite do not import from that folder.
    const root = await project({
      'src/page.html': '<img src="/a.png">\n',
      'src/app.js': "import a from './assets/a.png';\n",
      'public/a.png': 'LOGO',
      'src/assets/a.png': 'LOGO',
    });

    const served = await dedupeProject({
      root,
      apply: false,
      declared: { dirs: ['public'], declared: true },
    });
    const bundled = await dedupeProject({
      root,
      apply: false,
      declared: { dirs: ['public'], declared: true },
      keep: ['src/assets/a.png'],
    });

    expect(served.plan.sets[0]).toMatchObject({ keep: 'public/a.png', kept: 'served' });
    expect(served.plan.rewrites).toEqual([]);
    expect(served.plan.sets[0]?.copies[0]).toMatchObject({
      path: 'src/assets/a.png',
      moved: 0,
      unusedAfter: false,
      stays: [expect.objectContaining({ file: 'src/app.js', text: './assets/a.png' })],
    });
    expect(bundled.plan.sets[0]?.copies[0]?.stays[0]?.why).toContain(
      'a URL can load only a file a folder the site is served from holds',
    );
  });

  it('writes through the transaction, deletes nothing, and revert puts every byte back', async () => {
    const root = await project(TWO_COPIES);
    const before = await readFile(join(root, 'index.html'), 'utf8');

    const { manifest } = await dedupeProject({
      root,
      apply: true,
      runId: 'run-dedupe',
      now: () => '2026-09-29T00:00:00.000Z',
    });
    const after = await readFile(join(root, 'index.html'), 'utf8');
    if (manifest === null) throw new Error('the run wrote nothing');
    await revert(manifest, createNodeFileStore(root), () => '2026-09-29T00:00:01.000Z');

    expect(manifest.operations).toEqual([
      expect.objectContaining({ kind: 'edit', path: 'index.html' }),
    ]);
    expect(after).toBe('<img src="img/logo-copy.png">\n<img src="img/logo-copy.png">\n');
    expect(await readFile(join(root, 'img/logo.png'))).toEqual(await readFile(LOGO));
    expect(await readFile(join(root, 'index.html'), 'utf8')).toBe(before);
  });
});
