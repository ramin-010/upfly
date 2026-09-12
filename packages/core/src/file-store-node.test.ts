/**
 * The store that actually touches a disk.
 *
 * Until this file existed the module had no tests and no callers: it was reachable
 * only through the package index, and every transaction test ran against the
 * in-memory double. A module nothing calls looks exactly like a module that works.
 *
 * Two halves, and the split is deliberate. Everything that can be observed on a real
 * filesystem is tested on one, in the OS temp directory rather than anywhere inside
 * the workspace. The busy retry cannot be: neither a read-only file nor one with an
 * open handle produces EBUSY or EPERM from Node on Windows, both delete cleanly, so
 * that half injects the failure through `FileOperations` and still drives it through
 * the store rather than calling the retry directly.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type FileOperations,
  createFileStoreOn,
  createNodeFileStore,
  nodeFileOperations,
} from './file-store-node.js';
import type { FileStore } from './transaction.js';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** An error carrying a `code`, which is the only part the store reads. */
function failure(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe('on a real filesystem', () => {
  let root: string;
  let store: FileStore;

  beforeEach(async () => {
    // Outside the workspace on purpose. The v2 extension watches in-repo `public/`
    // directories and converts what it finds in place, which has already destroyed
    // a set of fixture files, and this suite writes a `public/` of its own.
    root = await mkdtemp(join(tmpdir(), 'upfly-store-'));
    store = createNodeFileStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe('hash', () => {
    it('is null for a path that is not there', async () => {
      expect(await store.hash('nothing/here.png')).toBeNull();
    });

    it('is taken over the bytes on disk rather than over decoded text', async () => {
      // Not valid UTF-8. Reading as text would replace these and hash something the
      // file does not contain, which would make a manifest disagree with the disk it
      // was written from.
      const bytes = Uint8Array.from([0xff, 0xfe, 0x41, 0x00]);
      await writeFile(join(root, 'raw.bin'), bytes);

      expect(await store.hash('raw.bin')).toBe(sha256(bytes));
    });

    it('names the function it used', async () => {
      await writeFile(join(root, 'a.txt'), 'contents');

      expect(store.hashAlgorithm).toBe('sha256');
      expect(await store.hash('a.txt')).toBe(sha256(Buffer.from('contents', 'utf8')));
    });
  });

  describe('paths', () => {
    it('resolves POSIX-relative paths against the root, separators included', async () => {
      await store.writeText('public/images/hero.txt', 'HERO');

      expect(await readFile(join(root, 'public', 'images', 'hero.txt'), 'utf8')).toBe('HERO');
      expect(await store.readText('public/images/hero.txt')).toBe('HERO');
    });
  });

  describe('writeText', () => {
    it('creates the directories leading to a file nothing has written yet', async () => {
      await store.writeText('a/b/c/deep.txt', 'DEEP');

      expect(await store.readText('a/b/c/deep.txt')).toBe('DEEP');
    });

    it('replaces the contents of a file that is already there', async () => {
      await store.writeText('x.txt', 'first');
      await store.writeText('x.txt', 'second');

      expect(await store.readText('x.txt')).toBe('second');
    });
  });

  describe('createExclusive, which is what makes R68 lock rather than pretend to', () => {
    /**
     * ⚠️ **Every other test of the lock runs against the in-memory store**, where
     * exclusivity is three lines this project wrote and could therefore have written
     * to agree with itself. The real guarantee is `O_EXCL` in the kernel, and it is
     * only real on a real filesystem — so it is tested here, on one.
     */
    it('creates a file that is not there and reports that it did', async () => {
      expect(await store.createExclusive('lock', 'FIRST')).toBe(true);
      expect(await store.readText('lock')).toBe('FIRST');
    });

    it('refuses a file that exists, and does not touch what is in it', async () => {
      // 🔴 The half that matters. If this overwrote, the lock would hand itself to
      // every run that asked and the refusal would never fire on a real machine, while
      // every in-memory test stayed green.
      await store.createExclusive('lock', 'FIRST');

      expect(await store.createExclusive('lock', 'SECOND')).toBe(false);
      expect(await store.readText('lock')).toBe('FIRST');
    });

    it('creates the directory leading to it, because .upfly may not exist yet', async () => {
      // The lock lives beside the manifest, and on a first run nothing has made that
      // directory. Failing here would mean the very first applied run could not lock.
      expect(await store.createExclusive('.upfly/lock', 'HELD')).toBe(true);
      expect(await store.readText('.upfly/lock')).toBe('HELD');
    });

    it('lets a cleared lock be taken again', async () => {
      // Stale-lock recovery removes the file and immediately re-creates it. If the
      // second create failed the recovery path would refuse forever.
      await store.createExclusive('lock', 'FIRST');
      await store.remove('lock');

      expect(await store.createExclusive('lock', 'SECOND')).toBe(true);
    });

    it('only ONE of many simultaneous creates wins', async () => {
      // The property the whole design rests on, asserted against the kernel rather
      // than against our own map. Twenty callers race for one path; exactly one may be
      // told it created it, or two runs would both believe they hold the lock.
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, index) => store.createExclusive('race', `w${index}`)),
      );

      expect(results.filter(Boolean)).toHaveLength(1);
    });
  });

  describe('copy', () => {
    it('creates the directories leading to the destination', async () => {
      await store.writeText('src/logo.txt', 'BYTES');
      await store.copy('src/logo.txt', 'staged/nested/logo.txt');

      expect(await store.readText('staged/nested/logo.txt')).toBe('BYTES');
    });

    it('refuses a destination that already exists rather than overwriting it', async () => {
      // The transaction only ever copies to a path it has established should not be
      // there, so arriving at one that is means the plan and the disk disagree. This
      // is also where the in-memory double differs: it overwrites, so no test running
      // against it can see this at all.
      await store.writeText('from.txt', 'NEW');
      await store.writeText('to.txt', 'ALREADY HERE');

      await expect(store.copy('from.txt', 'to.txt')).rejects.toMatchObject({ code: 'EEXIST' });
      expect(await store.readText('to.txt')).toBe('ALREADY HERE');
    });

    it('reports a source that is not there', async () => {
      await expect(store.copy('missing.txt', 'to.txt')).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  describe('remove', () => {
    it('deletes a file that is there', async () => {
      await store.writeText('gone.txt', 'BYTES');
      await store.remove('gone.txt');

      expect(await store.hash('gone.txt')).toBeNull();
    });

    it('accepts a path that is already absent, so undo can be repeated', async () => {
      await expect(store.remove('never-existed.txt')).resolves.toBeUndefined();
    });
  });
});

describe('the busy retry', () => {
  /**
   * Operations that fail with `code` the first `failures` times each call site asks.
   *
   * Counted per operation rather than in total, so a test can say that `writeText`
   * recovered without the count being spent by the `ensureDirectory` before it.
   */
  function flaky(
    code: string,
    failures: number,
  ): { operations: FileOperations; attempts: () => Record<string, number> } {
    const attempts: Record<string, number> = {};

    const unreliable =
      <T extends unknown[]>(name: string, real: (...args: T) => Promise<void>) =>
      async (...args: T): Promise<void> => {
        const seen = (attempts[name] ?? 0) + 1;
        attempts[name] = seen;
        if (seen <= failures) throw failure(code);
        await real(...args);
      };

    return {
      attempts: () => attempts,
      operations: {
        ...nodeFileOperations,
        write: unreliable('write', nodeFileOperations.write),
        copy: unreliable('copy', nodeFileOperations.copy),
        remove: unreliable('remove', nodeFileOperations.remove),
      },
    };
  }

  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'upfly-store-retry-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('carries writeText through an EBUSY and leaves the file written', async () => {
    const { operations, attempts } = flaky('EBUSY', 2);
    const store = createFileStoreOn(operations, root);

    await store.writeText('held.txt', 'WRITTEN');

    expect(attempts().write).toBe(3);
    expect(await readFile(join(root, 'held.txt'), 'utf8')).toBe('WRITTEN');
  });

  it('carries copy through an EPERM, which is what a scanner produces', async () => {
    const { operations, attempts } = flaky('EPERM', 2);
    const store = createFileStoreOn(operations, root);
    await writeFile(join(root, 'from.txt'), 'BYTES');

    await store.copy('from.txt', 'to.txt');

    expect(attempts().copy).toBe(3);
    expect(await readFile(join(root, 'to.txt'), 'utf8')).toBe('BYTES');
  });

  it('carries remove through an EBUSY', async () => {
    const { operations, attempts } = flaky('EBUSY', 2);
    const store = createFileStoreOn(operations, root);
    await writeFile(join(root, 'gone.txt'), 'BYTES');

    await store.remove('gone.txt');

    expect(attempts().remove).toBe(3);
    expect(await store.hash('gone.txt')).toBeNull();
  });

  it('gives up rather than retrying forever, and rethrows what the disk said', async () => {
    const { operations, attempts } = flaky('EBUSY', Number.POSITIVE_INFINITY);
    const store = createFileStoreOn(operations, root);

    await expect(store.writeText('held.txt', 'NEVER')).rejects.toMatchObject({ code: 'EBUSY' });
    // One first attempt plus five retries. A test asserting only that it eventually
    // throws would pass against a store that never retried at all.
    expect(attempts().write).toBe(6);
  });

  it('does not retry a failure a retry cannot help', async () => {
    const { operations, attempts } = flaky('ENOSPC', Number.POSITIVE_INFINITY);
    const store = createFileStoreOn(operations, root);

    await expect(store.writeText('full.txt', 'NEVER')).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(attempts().write).toBe(1);
  });
});
