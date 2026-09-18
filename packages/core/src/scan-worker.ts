/**
 * One parse pool worker: text in, a plain result out.
 *
 * 🔴 **It calls `parseOne`, the same function the unpooled path calls.** That is the whole
 * design and it is what makes R134's named trap unreachable. R134 warned that
 * `UpflyError.partial` must survive the worker boundary and that **structured clone does
 * not preserve an `Error` subclass's prototype** — so a pool that posted the error back
 * and rebuilt it on the far side would be one `instanceof` away from silently discarding
 * the references found before an unclosed `<style>` (R20, R86), in a place R90 already
 * proved nothing looks.
 *
 * ✅ **So no error ever crosses.** `parseOne` catches the throw *here*, narrows
 * `UpflyError.partial` into `references` *here*, and builds the `UnscannedFile` and the
 * diagnostic *here*. What crosses is a `ScannedFile`: arrays of primitives. There is no
 * prototype left to lose.
 *
 * ## ⚠️ The pool is only ever given the DEFAULT adapters, and that is a real limit
 *
 * An `Adapter` is an object of functions and functions do not clone, so a worker cannot be
 * handed the caller's adapter set — it must import its own and match on `adapterId`.
 * **A caller supplying a custom adapter therefore cannot be pooled**, and `scan.ts`
 * refuses the pool for that caller rather than silently scanning with different adapters
 * than `discover` used. That refusal is reported, not swallowed: `ScanResult.pool.reason`
 * says `custom-adapter`, because a pool that quietly changed which adapter read a file
 * would change the answer, not just the speed.
 */

import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { defaultAdapters } from './adapters/default-adapters.js';
import { type ScannedFile, parseOne } from './scan.js';
import type { Adapter, SourceFile } from './types.js';

/** What the pool sends for one file. Everything here is structured-cloneable. */
export interface ScanTaskMessage {
  readonly id: number;
  readonly file: SourceFile;
  readonly text: string;
}

/** What comes back. `ScannedFile` is arrays of primitives; see the note above. */
export interface ScanTaskResult {
  readonly id: number;
  readonly scanned: ScannedFile | null;
  /**
   * Set only when the worker itself failed, which is a bug in the pool rather than in the
   * file. 🔴 **The caller re-parses that file on the main thread instead of dropping it.**
   * A silent skip is a P0 (rule 9), and "the pool had a bad day" must not become "this
   * repository has no references in it".
   */
  readonly workerError: string | null;
}

const byId = new Map<string, Adapter>(defaultAdapters.map((adapter) => [adapter.id, adapter]));

/**
 * Basenames arrive once, at spawn, rather than with every file.
 *
 * A repository has thousands of them and 7,681 files; cloning the set per task would have
 * cost more than the parse it is there to move off the main thread.
 */
const assetBasenames: ReadonlySet<string> = new Set<string>(
  (workerData as { assetBasenames?: readonly string[] } | null)?.assetBasenames ?? [],
);

if (!isMainThread && parentPort !== null) {
  const port = parentPort;
  port.on('message', (message: ScanTaskMessage) => {
    try {
      const adapter = byId.get(message.file.adapterId);
      if (adapter === undefined) {
        // Cannot happen: `scan.ts` refuses the pool unless every adapter is a default one.
        // Reported rather than thrown, so the caller re-parses on the main thread and the
        // file reaches the report either way.
        port.postMessage({
          id: message.id,
          scanned: null,
          workerError: `adapter '${message.file.adapterId}' is not a default adapter`,
        } satisfies ScanTaskResult);
        return;
      }

      port.postMessage({
        id: message.id,
        scanned: parseOne(
          message.file,
          adapter,
          message.text,
          assetBasenames.size === 0 ? undefined : assetBasenames,
        ),
        workerError: null,
      } satisfies ScanTaskResult);
    } catch (error) {
      // `parseOne` catches every adapter throw already, so reaching here means the pool
      // itself broke. A throw inside a worker's message handler is an unhandled rejection
      // that takes the worker down and hangs every task queued behind it.
      port.postMessage({
        id: message.id,
        scanned: null,
        workerError: error instanceof Error ? error.message : String(error),
      } satisfies ScanTaskResult);
    }
  });
}
