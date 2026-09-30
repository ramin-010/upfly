/**
 * The tarball check the packed-install job runs, and both packages as `pnpm pack` makes them:
 * each tarball holds every entry its `files` list names, the licence, and a README.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { missingFromPack, tarPaths, unwantedInPack } from './pack-check.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** A gzipped tar of one-byte files, laid out as npm and pnpm write one. */
function tarOf(names: readonly string[], longName?: string): Buffer {
  const blocks: Buffer[] = [];
  const header = (name: string, type: string, size: number) => {
    const block = Buffer.alloc(512);
    block.write(name, 0, 'utf8');
    block.write(size.toString(8).padStart(11, '0'), 124);
    block.write(type, 156);
    return block;
  };
  const body = (text: string) => {
    const block = Buffer.alloc(Math.ceil(Buffer.byteLength(text) / 512) * 512);
    block.write(text);
    return block;
  };
  if (longName !== undefined) {
    const record = ` path=${longName}\n`;
    const text = `${record.length + String(record.length).length}${record}`;
    blocks.push(header('PaxHeader', 'x', Buffer.byteLength(text)), body(text));
    blocks.push(header(longName.slice(0, 99), '0', 1), body('x'));
  }
  for (const name of names) blocks.push(header(name, '0', 1), body('x'));
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

describe('pack-check', () => {
  it('reads the path of every file in a tar, a long one from its pax record', () => {
    const long = `package/dist/${'deeply/'.repeat(16)}module.js`;
    expect(tarPaths(tarOf(['package/package.json', 'package/dist/bin.js'], long))).toEqual([
      long,
      'package/package.json',
      'package/dist/bin.js',
    ]);
  });

  it('names each entry of files the tarball does not hold, a folder counting when it holds a file', () => {
    const paths = ['package/dist/bin.js', 'package/README.md', 'package/package.json'];
    expect(missingFromPack(['dist/', 'schema/', 'README.md', 'LICENSE'], paths)).toEqual([
      'schema/',
      'LICENSE',
    ]);
    expect(missingFromPack(['dist', 'README.md'], paths)).toEqual([]);
  });

  it('reads an entry starting with ! as one that leaves files out, not one the tarball holds', () => {
    const paths = ['package/dist/bin.js', 'package/README.md'];
    expect(missingFromPack(['dist/', '!dist/.tsbuildinfo', '!dist/**/*.map'], paths)).toEqual([]);
  });

  it('names the build cache and every source map, which point at a src/ the package does not ship', () => {
    const paths = [
      'package/dist/.tsbuildinfo',
      'package/dist/index.js',
      'package/dist/index.js.map',
      'package/dist/index.d.ts.map',
      'package/package.json',
    ];
    expect(unwantedInPack(paths)).toEqual([
      'dist/.tsbuildinfo',
      'dist/index.js.map',
      'dist/index.d.ts.map',
    ]);
    expect(unwantedInPack(['package/dist/index.js', 'package/dist/sitemap.xml'])).toEqual([]);
  });

  it('fails on a tarball holding either, naming what it holds', () => {
    const out = mkdtempSync(join(tmpdir(), 'upfly-pack-check-'));
    try {
      const tarball = join(out, 'upfly-core-0.0.0.tgz');
      const whole = ['package/dist/index.js', 'package/README.md', 'package/LICENSE'];
      writeFileSync(tarball, tarOf([...whole, 'package/dist/.tsbuildinfo']));
      const run = spawnSync(
        process.execPath,
        [join(ROOT, 'tools', 'pack-check.mjs'), join(ROOT, 'packages', 'core'), tarball],
        { encoding: 'utf8' },
      );
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('dist/.tsbuildinfo');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe('each package, as pnpm packs it', () => {
  const out = mkdtempSync(join(tmpdir(), 'upfly-pack-'));
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it.each([
    ['cli', 'README.md'],
    ['core', null],
  ])(
    'packages/%s holds every entry of its files list, the licence and a README',
    (folder, copiedReadme) => {
      const dir = join(ROOT, 'packages', folder);
      const packed = spawnSync('pnpm', ['pack', '--pack-destination', out], {
        cwd: dir,
        encoding: 'utf8',
        shell: process.platform === 'win32',
      });
      expect(packed.status, packed.stderr).toBe(0);

      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      const paths = tarPaths(readFileSync(join(out, `${manifest.name}-${manifest.version}.tgz`)));
      expect(missingFromPack(manifest.files, paths)).toEqual([]);
      expect(unwantedInPack(paths)).toEqual([]);
      expect(paths).toEqual(expect.arrayContaining(['package/LICENSE', 'package/README.md']));

      // The copies prepack makes are the root's files, byte for byte; core's README is its own.
      expect(readFileSync(join(dir, 'LICENSE'))).toEqual(readFileSync(join(ROOT, 'LICENSE')));
      const readme = readFileSync(join(dir, 'README.md'), 'utf8');
      if (copiedReadme === null) expect(readme).toMatch(/^# upfly-core\n/);
      else expect(readme).toBe(readFileSync(join(ROOT, 'README.md'), 'utf8'));
    },
    60_000,
  );
});
