/**
 * Which images count as served decides what `--replace` may delete, and it has to be the
 * same decision the resolver used: every serving root the run found, and a sentence of its
 * own when it found none. These run the exit criterion's own path, `optimizeTree`, over
 * trees written outside the workspace, with real encodes and real deletes.
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Manifest } from 'upfly-core';
import { afterEach, describe, expect, it } from 'vitest';
import { optimizeTree } from './engine-run.js';

/** Noise, so a lossy WebP always comes out smaller and the planner converts it. */
async function photo(): Promise<Buffer> {
  const { default: sharp } = await import('sharp');
  return sharp({
    create: {
      width: 64,
      height: 64,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
      noise: { type: 'gaussian', mean: 128, sigma: 40 },
    },
  })
    .png()
    .toBuffer();
}

const trees: string[] = [];
afterEach(async () => {
  for (const root of trees.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tree(files: Record<string, string | null>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'upfly-served-'));
  trees.push(root);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text ?? (await photo()));
  }
  return root;
}

function deleted(manifest: Manifest | null): string[] {
  return (manifest?.operations ?? [])
    .flatMap((operation) => (operation.kind === 'delete' ? [operation.path] : []))
    .sort();
}

const APP = '{ "name": "app", "private": true }\n';

describe('which images --replace may delete', () => {
  it('deletes an original in the one website folder once its reference moves', async () => {
    const root = await tree({
      'package.json': APP,
      'index.html': '<img src="/logo.png">\n',
      'public/logo.png': null,
    });

    const { manifest } = await optimizeTree(root, undefined, 'replace');

    expect(deleted(manifest)).toEqual(['public/logo.png']);
    expect(existsSync(join(root, 'public/logo.webp'))).toBe(true);
    expect(await readFile(join(root, 'index.html'), 'utf8')).toBe('<img src="/logo.webp">\n');
  });

  it('deletes an original in the second of two website folders, as in the first', async () => {
    const root = await tree({
      'apps/a/package.json': APP,
      'apps/a/index.html': '<img src="/a.png">\n',
      'apps/a/public/a.png': null,
      'apps/b/package.json': APP,
      'apps/b/index.html': '<img src="/b.png">\n',
      'apps/b/public/b.png': null,
    });

    const { plan, manifest } = await optimizeTree(root, undefined, 'replace');

    expect(deleted(manifest)).toEqual(['apps/a/public/a.png', 'apps/b/public/b.png']);
    expect(existsSync(join(root, 'apps/b/public/b.png'))).toBe(false);
    expect(await readFile(join(root, 'apps/b/index.html'), 'utf8')).toBe('<img src="/b.webp">\n');
    expect(plan.keptOriginals).toEqual([]);
  });

  describe('a plain HTML site with no website folder to find', () => {
    const SITE = {
      'index.html': '<img src="img/hero.png">\n',
      'img/hero.png': null,
      'img/unused.png': null,
    };

    it('keeps every original and says how to name the folder', async () => {
      const root = await tree(SITE);

      const { plan, manifest } = await optimizeTree(root, undefined, 'replace');

      expect(deleted(manifest)).toEqual([]);
      expect(existsSync(join(root, 'img/hero.png'))).toBe(true);
      expect(plan.keptOriginals.map((kept) => kept.asset)).toEqual(['img/hero.png']);
      expect(plan.keptOriginals[0]?.reason).toContain('no website folder was found');
      expect(plan.keptOriginals[0]?.reason).toContain('`--public <dir>`');
      expect(plan.declined.find((entry) => entry.path === 'img/unused.png')?.reason).toContain(
        'no website folder was found',
      );
    });

    it('deletes once the project root is declared as the website folder', async () => {
      const root = await tree(SITE);

      const { plan, manifest } = await optimizeTree(
        root,
        { dirs: [''], declared: true },
        'replace',
      );

      expect(deleted(manifest)).toEqual(['img/hero.png']);
      expect(await readFile(join(root, 'index.html'), 'utf8')).toBe('<img src="img/hero.webp">\n');
      expect(plan.keptOriginals).toEqual([]);
    });
  });
});
