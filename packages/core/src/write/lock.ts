/**
 * One writer at a time: a second run is refused while another holds the project's lock.
 *
 * The manifest is one fixed path, and `undo` restores the run it records. If two runs
 * wrote at once, one would replace the other's manifest, and that run's backups would be
 * left with nothing pointing at them, so the originals it removed could not be put back.
 * See "One writer at a time" in ARCHITECTURE.md.
 */

import { UpflyError } from '../errors.js';
import type { FileStore } from './transaction.js';

/** Where the lock lives. One per project, beside the manifest it protects. */
export const LOCK_PATH = '.upfly/lock';

/**
 * Who holds the lock. `pid` is what shows the holder is still alive; `startedAt` and
 * `runId` let a person looking at a stuck project see what is holding it.
 */
export interface LockHolder {
  readonly pid: number;
  /** ISO 8601, from the run's own clock. */
  readonly startedAt: string;
  readonly runId: string;
}

/**
 * Whether a process is still running. Injectable so that a test can present another
 * process as alive.
 */
export type ProcessLiveness = (pid: number) => boolean;

/** The real check. Signal 0 tests whether a process exists without affecting it. */
export const processIsAlive: ProcessLiveness = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to somebody else, which is still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export interface LockOptions {
  readonly store: FileStore;
  /**
   * The run asking for the lock. The same run in the same process may take it again:
   * `optimize` holds the lock around `prepare` and `commit`, and `commit` takes it itself,
   * so without re-entry every applied run would refuse itself. The run id is needed as
   * well as the pid because two runs in one process share a pid.
   */
  readonly runId: string;
  readonly now: () => string;
  /** This process. Injected only so a test can act as another one. */
  readonly pid?: number;
  readonly isAlive?: ProcessLiveness;
}

/** A held lock. `release` is safe to call once, and only the owner removes the file. */
export interface LockHandle {
  /**
   * True when this run already held the lock and this acquisition nested inside it. Its
   * release does nothing: the outermost holder owns the file, so an inner `commit`
   * finishing must not unlock the run that is still going.
   */
  readonly reentered: boolean;
  release(): Promise<void>;
}

/**
 * Take the lock, or refuse.
 *
 * @throws {UpflyError} `TRANSACTION_LOCKED` when another run holds it and is alive.
 */
export async function acquireLock(options: LockOptions): Promise<LockHandle> {
  const { store, runId, now } = options;
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? processIsAlive;
  const holder: LockHolder = { pid, startedAt: now(), runId };

  if (await store.createExclusive(LOCK_PATH, `${JSON.stringify(holder, null, 2)}\n`)) {
    return { reentered: false, release: () => releaseIfOwner(store, runId, pid, isAlive) };
  }

  const current = await readLock(store);

  // Not cleared: the exclusive create and the write of the holder are two steps, so a lock
  // this run cannot read may be one another run is writing at this moment. Clearing it
  // would let both runs hold the lock. A lock cut short by a crash stays until removed by
  // hand, which the message says how to do.
  if (current === 'unreadable') {
    throw new UpflyError(
      'TRANSACTION_LOCKED',
      `${LOCK_PATH} exists but does not yet name a run, so another run may be starting at this moment. If no Upfly run is going, delete ${LOCK_PATH} and try again.`,
    );
  }

  // Ours already: `optimize` is holding it around a `commit` that is now asking too. The
  // process must match as well as the run: an undo in another process reads the same run
  // id from the manifest, and must not walk into that run while it is still writing.
  if (current !== null && current.runId === runId && current.pid === pid) {
    return { reentered: true, release: async () => {} };
  }

  // A process that died mid-run leaves its lock behind, and that must not block the project
  // for good. Stale means the holder's process is gone: an age limit would only guess, and
  // a long run looks the same as a stuck one to a clock. `null` means the lock was released
  // between the create above and this read.
  if (current !== null && isAlive(current.pid)) {
    throw new UpflyError(
      'TRANSACTION_LOCKED',
      `Another Upfly run is in progress (run ${current.runId}, process ${current.pid}, started ${current.startedAt}). Wait for it to finish and try again.`,
    );
  }

  await store.remove(LOCK_PATH);
  if (await store.createExclusive(LOCK_PATH, `${JSON.stringify(holder, null, 2)}\n`)) {
    return { reentered: false, release: () => releaseIfOwner(store, runId, pid, isAlive) };
  }

  // Someone else cleared the same stale lock and took it first. One retry, never a
  // loop: a loop here turns a contended directory into a spin.
  throw new UpflyError(
    'TRANSACTION_LOCKED',
    'Another Upfly run took the lock while this one was clearing a stale lock. Try again.',
  );
}

/**
 * Remove the lock, but only if it is still ours. Otherwise a run whose lock had been
 * cleared as stale would delete its successor's lock on the way out, and a third run
 * would find the project free while two runs are writing.
 */
async function releaseIfOwner(
  store: FileStore,
  runId: string,
  pid: number,
  _isAlive: ProcessLiveness,
): Promise<void> {
  const current = await readLockHolder(store);
  if (current === null) return;
  if (current.runId !== runId || current.pid !== pid) return;
  await store.remove(LOCK_PATH);
}

/**
 * Who holds the project's lock, or `null` when nobody does or the file cannot be read.
 *
 * `null` does not mean the lock is free: a file that cannot be read may be one another run
 * is writing, and `acquireLock` refuses it.
 *
 * @param store the project's file store
 */
export async function readLockHolder(store: FileStore): Promise<LockHolder | null> {
  const current = await readLock(store);
  return current === 'unreadable' ? null : current;
}

/**
 * The lock's holder, `null` when there is no lock file, or `'unreadable'` when there is one
 * that does not name a holder: being written, or cut short.
 */
async function readLock(store: FileStore): Promise<LockHolder | null | 'unreadable'> {
  if ((await store.hash(LOCK_PATH)) === null) return null;
  try {
    const parsed: unknown = JSON.parse(await store.readText(LOCK_PATH));
    if (typeof parsed !== 'object' || parsed === null) return 'unreadable';
    const { pid, startedAt, runId } = parsed as Partial<LockHolder>;
    if (typeof pid !== 'number' || typeof startedAt !== 'string' || typeof runId !== 'string') {
      return 'unreadable';
    }
    return { pid, startedAt, runId };
  } catch (error) {
    // Gone between the hash and the read: released, which is no lock at all.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return 'unreadable';
  }
}
