import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { LOCK_PATH, processIsAlive } from './lock.js';
import { MANIFEST_PATH } from './manifest.js';
import { type FileStore, type RunContext, commit } from './transaction.js';

/**
 * R68 — two writers, one manifest.
 *
 * 🔴 **The ruling asks for a test that starts a second transaction while the first
 * holds the lock, and explicitly NOT a unit test of the lock helper**, because this
 * project has shipped four guards that never fired. So everything here goes through
 * the real `commit`, and the first transaction is genuinely suspended mid-flight
 * holding a genuinely created lock file.
 *
 * ⚠️ **The fixture here is the HELD LOCK, and it is mutated the way R67 says a fixture
 * must be.** Two of the tests below exist only to break the premise on purpose: one
 * removes the lock before the second run starts, one gives it a live holder instead of
 * a dead one. If the refusal survived either, it would be firing for some reason other
 * than the lock, and the tests that assert it would be measuring nothing. That is the
 * lesson from `partial-pattern`, where a premise test hardcoded 70 bytes and could not
 * see its own premise change.
 *
 * **No pid is hardcoded and no timestamp is asserted.** A dead pid is obtained by
 * running a real process and letting it exit, which is the only way to have one that
 * is dead as a fact rather than as an assumption.
 */

/** A pid that is dead because a real process used it and exited. */
function deadPid(): number {
  // `spawnSync` returns after the child has exited, so this pid is free by the time
  // it is read. Node itself is used rather than a shell so the call means the same
  // thing on every platform.
  const { pid } = spawnSync(process.execPath, ['-e', '']);
  if (pid === undefined) throw new Error('could not spawn a process to get a dead pid');

  // ⚠️ The one guard against the flake this technique can have. If the operating
  // system has already recycled the pid, this test's premise is false, and it must
  // say so loudly rather than pass for the wrong reason.
  if (processIsAlive(pid)) throw new Error(`pid ${pid} was recycled before the test could use it`);
  return pid;
}

function memoryStore(files = new Map<string, string>()) {
  const store: FileStore = {
    hashAlgorithm: 'sha256',
    async hash(path) {
      const text = files.get(path);
      return text === undefined ? null : `h:${text.length}`;
    },
    async readText(path) {
      const text = files.get(path);
      if (text === undefined) throw new Error(`no such file: ${path}`);
      return text;
    },
    async writeText(path, text) {
      files.set(path, text);
    },
    // Real exclusivity. A store that overwrote here would make every assertion below
    // pass against a lock that could never refuse.
    async createExclusive(path, text) {
      if (files.has(path)) return false;
      files.set(path, text);
      return true;
    },
    async copy(from, to) {
      const text = files.get(from);
      if (text === undefined) throw new Error(`no such file: ${from}`);
      files.set(to, text);
    },
    async remove(path) {
      files.delete(path);
    },
  };
  return { files, store };
}

function contextFor(runId: string): RunContext {
  return {
    runId,
    runDir: `.upfly/runs/${runId}`,
    now: () => '2026-09-13T00:00:00.000Z',
    declined: [],
  };
}

/**
 * A store that suspends the first manifest write until the test lets it go.
 *
 * This is what makes the first transaction genuinely *in progress*: it has taken the
 * lock and has not finished, which is the state a second run has to meet. Stubbing the
 * lock file instead would test a file, not a transaction.
 */
function suspendable(store: FileStore) {
  let release = (): void => {};
  const suspended = new Promise<void>((resolve) => {
    release = resolve;
  });
  let armed = true;
  let reached = (): void => {};
  const inside = new Promise<void>((resolve) => {
    reached = resolve;
  });

  const wrapped: FileStore = {
    ...store,
    async writeText(path, text) {
      if (armed && path === MANIFEST_PATH) {
        armed = false;
        reached();
        await suspended;
      }
      return store.writeText(path, text);
    },
  };

  return { store: wrapped, release, inside };
}

describe('R68: two runs, one manifest', () => {
  it('refuses a second transaction while the first is still running', async () => {
    // 🔴 The failure this prevents, stated plainly: without the lock the second run
    // overwrites the first run's pending manifest, the first run then writes its own
    // committed manifest over that, and the second run's backups are left in
    // `.upfly/runs/<B>/` with nothing pointing at them. Its deletions become
    // unrecoverable, which is the one thing the transaction exists to guarantee.
    const { files, store } = memoryStore();
    const first = suspendable(store);

    const running = commit([], first.store, contextFor('run-a'));
    await first.inside;

    // The lock is a real file written by the real run, not a fixture the test placed.
    expect(files.has(LOCK_PATH)).toBe(true);

    await expect(commit([], store, contextFor('run-b'))).rejects.toThrow(
      expect.objectContaining({ code: 'TRANSACTION_LOCKED' }),
    );

    first.release();
    await running;
  });

  it('says which run holds it, so "try again" is something a user can check', async () => {
    const { store } = memoryStore();
    const first = suspendable(store);
    const running = commit([], first.store, contextFor('run-a'));
    await first.inside;

    // A bare "locked" leaves a user with no way to tell a live run from a stuck one.
    await expect(commit([], store, contextFor('run-b'))).rejects.toThrow(/run-a/);

    first.release();
    await running;
  });

  it('lets the second transaction through once the lock is GONE', async () => {
    // ⚠️ **The fixture mutation, kept as a permanent control.** Remove the held lock
    // and the same second run succeeds. Without this, the refusal above could be
    // firing for any reason at all — a hash mismatch, a store quirk — and the test
    // would read as proof of a lock that was doing nothing.
    const { files, store } = memoryStore();
    const first = suspendable(store);
    const running = commit([], first.store, contextFor('run-a'));
    await first.inside;

    files.delete(LOCK_PATH);

    await expect(commit([], store, contextFor('run-b'))).resolves.toMatchObject({
      state: 'committed',
    });

    first.release();
    await running;
  });

  it('releases the lock when the run finishes, so the next one may start', async () => {
    const { files, store } = memoryStore();

    await commit([], store, contextFor('run-a'));
    expect(files.has(LOCK_PATH)).toBe(false);

    await expect(commit([], store, contextFor('run-b'))).resolves.toMatchObject({
      state: 'committed',
    });
  });

  it('releases the lock even when the run fails, so a failure is not a brick', async () => {
    // A throw mid-commit must not leave the directory locked for the rest of the
    // process's life. The `finally` is what makes this true, and nothing else would.
    const { files, store } = memoryStore();
    const exploding: FileStore = {
      ...store,
      async writeText(path, text) {
        if (path === MANIFEST_PATH) throw new Error('injected failure');
        return store.writeText(path, text);
      },
    };

    await expect(commit([], exploding, contextFor('run-a'))).rejects.toThrow('injected failure');
    expect(files.has(LOCK_PATH)).toBe(false);
  });
});

describe('R68: a lock its holder did not survive', () => {
  /** A lock file exactly as a run would have written it, for a chosen holder. */
  function lockHeldBy(pid: number): string {
    return `${JSON.stringify({ pid, startedAt: '2026-09-13T00:00:00.000Z', runId: 'run-crashed' }, null, 2)}\n`;
  }

  it('clears a lock whose process is gone, rather than bricking the directory', async () => {
    // 🔴 Without this the first killed run makes the project permanently unusable, and
    // the only fix is a user deleting a file nobody ever told them about.
    const { files, store } = memoryStore();
    files.set(LOCK_PATH, lockHeldBy(deadPid()));

    await expect(commit([], store, contextFor('run-b'))).resolves.toMatchObject({
      state: 'committed',
    });
  });

  it('still refuses when the holder is ALIVE, which is the same test with one change', async () => {
    // ⚠️ **The second fixture mutation, also kept.** Identical lock file, identical
    // run, and only the holder's liveness differs — so the recovery above is caused by
    // the process being gone and not by the lock being readable, or old, or ours.
    const { files, store } = memoryStore();
    files.set(LOCK_PATH, lockHeldBy(process.pid));

    await expect(commit([], store, contextFor('run-b'))).rejects.toThrow(
      expect.objectContaining({ code: 'TRANSACTION_LOCKED' }),
    );
  });

  it('clears a lock that cannot be read at all', async () => {
    // A half-written lock from a power cut names no holder, so it cannot prove one is
    // alive. Refusing on the strength of nothing would brick the directory for a file
    // that means nothing.
    const { files, store } = memoryStore();
    files.set(LOCK_PATH, '{ this is not json');

    await expect(commit([], store, contextFor('run-b'))).resolves.toMatchObject({
      state: 'committed',
    });
  });

  it('does not treat a live holder as stale just because this process is the holder', async () => {
    // 🔴 The subtle one. Keying staleness on "the pid is not ours" instead of "the pid
    // is not running" would be invisible in production — where the two runs really are
    // separate processes — and would disable the lock entirely under test, where they
    // are not. The extension and a CLI run in one host process are exactly this case.
    const { files, store } = memoryStore();
    files.set(LOCK_PATH, lockHeldBy(process.pid));

    await expect(commit([], store, contextFor('run-b'))).rejects.toThrow(
      expect.objectContaining({ code: 'TRANSACTION_LOCKED' }),
    );
  });
});

describe('R68: a run may re-enter its own lock', () => {
  it('lets the same runId take the lock it already holds', async () => {
    // `optimize` holds the lock across `prepare` and `commit`, and `commit` takes it
    // again on its own behalf so a library consumer calling it directly is protected
    // too. Without re-entrancy every applied run would deadlock against itself.
    const { files, store } = memoryStore();
    files.set(
      LOCK_PATH,
      `${JSON.stringify({ pid: process.pid, startedAt: '2026-09-13T00:00:00.000Z', runId: 'run-a' }, null, 2)}\n`,
    );

    await expect(commit([], store, contextFor('run-a'))).resolves.toMatchObject({
      state: 'committed',
    });
  });

  it('leaves the outer hold in place when the inner one finishes', async () => {
    // The release of a re-entrant acquisition must be a no-op, or an inner `commit`
    // finishing would unlock a run that is still going — and the next run would walk
    // straight into the window this whole ruling exists to close.
    const { files, store } = memoryStore();
    const outer = `${JSON.stringify({ pid: process.pid, startedAt: '2026-09-13T00:00:00.000Z', runId: 'run-a' }, null, 2)}\n`;
    files.set(LOCK_PATH, outer);

    await commit([], store, contextFor('run-a'));

    expect(files.get(LOCK_PATH)).toBe(outer);
  });
});
