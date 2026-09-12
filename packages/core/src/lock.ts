/**
 * One writer at a time, enforced rather than assumed (R68).
 *
 * 🔴 **The single manifest is not a bug; it is a DESIGN that assumes one writer, and
 * the assumption was never enforced.** `.upfly/manifest.json` is one fixed path, not
 * one file per run, and `undo` restores *the last* run — which only means anything if
 * there is one. An unstated assumption is enforced by nothing.
 *
 * **What goes wrong without this.** A user runs `upfly optimize --apply` in a terminal
 * and pastes an image into the editor while it works. Run A writes a pending manifest,
 * run B overwrites it, run A finishes and writes its committed manifest. **Run B's
 * record is gone. Its backups still sit in `.upfly/runs/<B>/` with nothing pointing at
 * them, so its deletions are unrecoverable** — the one thing the transaction exists to
 * guarantee.
 *
 * ✅ File *integrity* was already safe: `commit` re-verifies `beforeHash` as it writes,
 * so two runs cannot corrupt the same file — the second refuses. **Recoverability was
 * not.** That is the gap this closes, and it is worth being precise about which one,
 * because the existing protection makes the remaining hole easy to talk yourself out of.
 *
 * **Refuse, never queue.** A queued run stalls silently behind a long one with no
 * explanation — the extension would simply appear frozen. A refusal names what is
 * happening and lets the user decide.
 */

import { UpflyError } from './errors.js';
import type { FileStore } from './transaction.js';

/** Where the lock lives. One per project, beside the manifest it protects. */
export const LOCK_PATH = '.upfly/lock';

/**
 * Who holds the lock.
 *
 * `pid` is what proves the holder is still alive; `startedAt` and `runId` are what let
 * a person reading a stuck directory understand what they are looking at, which a bare
 * pid does not.
 */
export interface LockHolder {
  readonly pid: number;
  /** ISO 8601, from the run's own clock. */
  readonly startedAt: string;
  readonly runId: string;
}

/**
 * Whether a process is still running.
 *
 * Injected for the same reason `now` is: a test needs a *genuinely* dead pid, and the
 * honest way to get one is to let a real process exit — not to assert against a number
 * chosen because it looked unused.
 */
export type ProcessLiveness = (pid: number) => boolean;

/** The real check. `signal 0` tests for existence without touching the process. */
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
   * The run asking for the lock.
   *
   * ⚠️ **This is what makes the lock re-entrant, and re-entrancy is not a convenience.**
   * `optimize` holds the lock across `prepare` and `commit` — the whole window in which
   * another run could overwrite the manifest — and `commit` takes it again on its own
   * behalf, because a library consumer calling `commit` directly deserves the same
   * protection. Without re-entrancy the outer hold would make the inner one refuse and
   * every applied run would deadlock against itself.
   *
   * Keyed on `runId` rather than on a pid, because two runs *in one process* are
   * exactly the case the extension creates and a pid cannot tell them apart.
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
   * True when this run already held the lock and this acquisition nested inside it.
   *
   * The release of a re-entrant acquisition is a no-op: the outermost holder owns the
   * file, so an inner `commit` finishing must not unlock the run that is still going.
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

  // ⚠️ **Exclusive creation, never `exists()` then `write()`.** The check-then-write
  // version is a race with exactly the shape of the bug being fixed: two runs both see
  // no lock, both write one, both proceed. The atomicity has to come from the
  // filesystem, which is why `FileStore` gained a method rather than this composing
  // two it already had.
  if (await store.createExclusive(LOCK_PATH, `${JSON.stringify(holder, null, 2)}\n`)) {
    return { reentered: false, release: () => releaseIfOwner(store, runId, pid, isAlive) };
  }

  const current = await readHolder(store);

  // Ours already: `optimize` is holding it around a `commit` that is now asking too.
  if (current !== null && current.runId === runId) {
    return { reentered: true, release: async () => {} };
  }

  // 🔴 A lock nobody is holding must not brick the directory. A process that died mid
  // run leaves this behind, and without recovery the only fix is a user deleting a
  // file we never told them about. Staleness is decided by the pid being GONE, which
  // is the only thing that actually proves it — an age threshold would guess, and a
  // long legitimate run looks exactly like a stuck one to a clock.
  const stale = current === null || !isAlive(current.pid);
  if (!stale) {
    throw new UpflyError(
      'TRANSACTION_LOCKED',
      `Another Upfly run is in progress (run ${current.runId}, process ${current.pid}, started ${current.startedAt}). Wait for it to finish and try again.`,
    );
  }

  // `current === null` covers a lock file that will not parse — truncated by a power
  // cut, or half-written. It cannot name a holder, so it cannot prove one is alive,
  // and leaving it in place would brick the directory on the strength of nothing.
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
 * Remove the lock, but only if it is still ours.
 *
 * Without the check a run whose lock had already been cleared as stale would delete
 * the *successor's* lock on its way out, handing a third run a directory that looks
 * free while two writers are inside it. That is a worse failure than the one being
 * fixed, because it would appear only under the contention this exists to handle.
 */
async function releaseIfOwner(
  store: FileStore,
  runId: string,
  pid: number,
  _isAlive: ProcessLiveness,
): Promise<void> {
  const current = await readHolder(store);
  if (current === null) return;
  if (current.runId !== runId || current.pid !== pid) return;
  await store.remove(LOCK_PATH);
}

/** The holder on disk, or `null` when there is none or it cannot be read. */
async function readHolder(store: FileStore): Promise<LockHolder | null> {
  if ((await store.hash(LOCK_PATH)) === null) return null;
  try {
    const parsed: unknown = JSON.parse(await store.readText(LOCK_PATH));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { pid, startedAt, runId } = parsed as Partial<LockHolder>;
    if (typeof pid !== 'number' || typeof startedAt !== 'string' || typeof runId !== 'string') {
      return null;
    }
    return { pid, startedAt, runId };
  } catch {
    return null;
  }
}
