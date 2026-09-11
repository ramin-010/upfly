/**
 * The real `FileStore`, backed by the filesystem.
 *
 * One of the small number of modules allowed to touch a disk, alongside `discover`
 * and the sharp probe. Everything above it stays testable against an in-memory
 * store, which is what makes the crash tests possible.
 */

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { FileStore } from './transaction.js';

/** Retries for a file another process is holding open. */
const BUSY_RETRIES = 5;
const BUSY_BACKOFF_MS = 20;

/**
 * The digest every hash in a manifest is made with.
 *
 * Named in one place and reported through `hashAlgorithm` so the manifest records
 * what actually produced its hashes. Changing it here changes what new manifests
 * declare, and an older manifest declaring the old name is then refused rather than
 * compared against incomparable values.
 */
const HASH_ALGORITHM = 'sha256';

/**
 * Build a store rooted at a project directory.
 *
 * Every path handed to the returned store is POSIX-relative to `root`. Resolving
 * them here rather than at the call sites is what keeps absolute paths out of the
 * manifest, which is what lets a manifest survive the project being moved.
 */
export function createNodeFileStore(root: string): FileStore {
  const absolute = (path: string): string => resolve(root, path);

  return {
    hashAlgorithm: HASH_ALGORITHM,

    async hash(path: string): Promise<string | null> {
      try {
        const bytes = await readFile(absolute(path));
        return createHash(HASH_ALGORITHM).update(bytes).digest('hex');
      } catch (cause) {
        if (isMissing(cause)) return null;
        throw cause;
      }
    },

    async readText(path: string): Promise<string> {
      return readFile(absolute(path), 'utf8');
    },

    async writeText(path: string, text: string): Promise<void> {
      const target = absolute(path);
      await mkdir(dirname(target), { recursive: true });
      await retryWhileBusy(() => writeFile(target, text, 'utf8'));
    },

    async copy(from: string, to: string): Promise<void> {
      const target = absolute(to);
      await mkdir(dirname(target), { recursive: true });
      // copyFile rather than rename throughout: a rename across volumes fails on
      // Windows, and staged bytes may legitimately sit on a different volume from
      // the project. Copying costs a write we would otherwise avoid and removes a
      // platform-specific failure that only shows up on somebody else's machine.
      await retryWhileBusy(() => copyFile(absolute(from), target, constants.COPYFILE_EXCL));
    },

    async remove(path: string): Promise<void> {
      // Tolerant of an already-absent file so that reverting a run twice, or
      // reverting one that was interrupted midway through its removals, is not an
      // error. Undo has to be safe to repeat.
      await retryWhileBusy(() => rm(absolute(path), { force: true }));
    },
  };
}

function isMissing(cause: unknown): boolean {
  return (cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/**
 * Retry an operation a file lock is blocking.
 *
 * On Windows an editor, an antivirus scanner or a dev server holding a handle open
 * produces EBUSY or EPERM for a few milliseconds. Failing the whole run for that
 * would make the tool unusable on the platform it is meant to be first-class on.
 */
async function retryWhileBusy(action: () => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await action();
      return;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException | undefined)?.code;
      const busy = code === 'EBUSY' || code === 'EPERM';
      if (!busy || attempt >= BUSY_RETRIES) throw cause;
      await new Promise((done) => setTimeout(done, BUSY_BACKOFF_MS * 2 ** attempt));
    }
  }
}
