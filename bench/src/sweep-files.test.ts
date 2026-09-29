import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_SEARCHED_BYTES, assetPathUnder, searchableText } from './sweep-files.js';

let temp: string;

beforeAll(async () => {
  temp = await mkdtemp(join(tmpdir(), 'upfly-sweep-'));
});

afterAll(async () => {
  await rm(temp, { recursive: true, force: true });
});

describe('what the recall sweep reads', () => {
  it('joins an asset path by segment, so it equals the walked path on POSIX and on Windows', () => {
    expect(assetPathUnder('/c', 'img/a.png', posix.join)).toBe('/c/img/a.png');
    expect(assetPathUnder('C:\\c', 'img/a.png', win32.join)).toBe('C:\\c\\img\\a.png');
  });

  it('counts its size limit in bytes, as the file system does', async () => {
    // Three quarters of the limit in characters, one and a half times it in bytes.
    const wide = join(temp, 'wide.txt');
    await writeFile(wide, 'é'.repeat((MAX_SEARCHED_BYTES / 4) * 3));
    const narrow = join(temp, 'narrow.txt');
    await writeFile(narrow, 'e'.repeat(MAX_SEARCHED_BYTES));

    expect(await searchableText(wide)).toBeUndefined();
    expect((await searchableText(narrow))?.length).toBe(MAX_SEARCHED_BYTES);
  });
});
