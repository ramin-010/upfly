/**
 * The parse pool, against real worker threads — and R134's named trap is the first test.
 *
 * ## 🔴 Why this file loads `dist` rather than source
 *
 * `vitest.config.ts` resolves `upfly-core` to `packages/core/src`, which is what stops a
 * stale build being silently validated. **A worker thread cannot load TypeScript**, so a
 * pool spawned from source would have no worker file to run — and the honest consequence
 * is that the pool's real behaviour can only be exercised against the built output.
 * `smoke.test.ts` already set that precedent and gives the reason it fails rather than
 * skips: *"a smoke test that quietly does nothing when the artefact is absent is exactly
 * the shape that let the packaged output go untested in the first place."*
 *
 * ⚠️ **`pnpm check` runs `typecheck` before `test`, and `typecheck` builds**, so `dist` is
 * current whenever the gate runs. A bare `pnpm test` may not be, which is one more reason
 * `pnpm check` is the gate and `pnpm test` is not.
 *
 * ## 🔴 The trap, and why it is first
 *
 * R134: *"`UpflyError.partial` MUST SURVIVE THE WORKER BOUNDARY. Structured clone does not
 * preserve an `Error` subclass's prototype. A pool that drops it silently re-creates R90's
 * defect where nothing looks."* B8 wired `partial` so the references found **before** an
 * unclosed `<style>` are not discarded (R20, R86), and losing them is what makes a
 * referenced asset look dead.
 *
 * ✅ **The fixture is a real markdown document read by the real markdown adapter**, not a
 * throwing stub. It has to be: a stub adapter is a custom adapter, the pool refuses those
 * on purpose (a worker imports its own adapters and matches on id), so a stubbed test
 * would have proved the unpooled path twice and called it a pooled one. **That is the
 * shape of test this project keeps finding — one that passes for a reason other than the
 * code being right.**
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const BUILT_ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url));

/**
 * Real worker threads, real spawn cost.
 *
 * ⚠️ Raised deliberately rather than after a red run, for the reason `root-inference.test.ts`
 * records: a test sitting at 94% of vitest's 5,000 ms default is not passing, it is waiting
 * to flake, and a flaky gate trains `[wip]`.
 */
const WORKER_TIMEOUT_MS = 60_000;

interface CoreModule {
  createScanPool: (
    workers: number,
    basenames: ReadonlySet<string> | undefined,
    workerUrl?: URL,
  ) => {
    run: (file: unknown, text: string) => Promise<unknown>;
    readonly fellBack: number;
    close: () => Promise<void>;
  } | null;
  scanSources: (options: Record<string, unknown>) => Promise<{
    references: readonly { rawPath: string; file: string }[];
    unscanned: readonly { relative: string; reason: string; detail: string }[];
    mentions: readonly { basename: string; relative: string }[];
    pool: { engaged: boolean; reason: string; workers: number; fellBack: number };
  }>;
  defaultAdapters: readonly { id: string; extensions: readonly string[] }[];
}

let core: CoreModule;

beforeAll(async () => {
  if (!existsSync(BUILT_ENTRY)) {
    throw new Error(
      'packages/core/dist is not built, so the parse pool cannot be tested: a worker thread cannot load TypeScript. Run `pnpm build` (or `pnpm typecheck`, which builds) and try again.',
    );
  }
  core = (await import(BUILT_ENTRY)) as unknown as CoreModule;
});

/**
 * A markdown document that finds a reference and THEN meets CSS it cannot parse.
 *
 * 🔴 **Verified to throw with a non-empty `partial` through the real adapter chain** —
 * markdown collects `![](hero.png)`, hands the raw HTML to parse5, which hands the
 * `<style>` block to PostCSS, which throws on the unclosed brace. Every reference above it
 * is correct and must survive, pooled or not.
 */
const PARTIAL_FIXTURE = '![hero](hero.png)\n\n<style>\n.a { color: red\n</style>\n';

function sourceFile(relative: string, adapterId: string) {
  return {
    path: `/repo/${relative}`,
    relative,
    extension: relative.slice(relative.lastIndexOf('.')),
    adapterId,
  };
}

function filesystem(files: Record<string, string>) {
  return async (path: string) => {
    const text = files[path];
    if (text === undefined) throw new Error(`ENOENT: ${path}`);
    return text;
  };
}

describe('R134’s trap: UpflyError.partial across the worker boundary', () => {
  it(
    'keeps the references found before the failure, pooled and unpooled, identically',
    async () => {
      const options = {
        sourceFiles: [sourceFile('guide.md', 'markdown')],
        adapters: core.defaultAdapters,
        readFile: filesystem({ '/repo/guide.md': PARTIAL_FIXTURE }),
      };

      const unpooled = await core.scanSources(options);
      const pooled = await core.scanSources({
        ...options,
        // `minFiles: 1` because the engagement floor exists to stop a pool being a net
        // loss, and a correctness test is not where that trade-off is being measured.
        pool: { workers: 2, minFiles: 1 },
      });

      // The pool ran. Without this the two halves below could agree because neither used
      // a worker, which is the assertion that proves nothing.
      expect(pooled.pool.engaged).toBe(true);
      expect(pooled.pool.reason).toBe('engaged');
      expect(pooled.pool.fellBack).toBe(0);

      // 🔴 The reference found before the throw. This is the whole of R134's warning.
      expect(unpooled.references.map((reference) => reference.rawPath)).toEqual(['hero.png']);
      expect(pooled.references.map((reference) => reference.rawPath)).toEqual(['hero.png']);

      // ✅ And rule 9's half: the file is still REPORTED as unscanned. A pool that kept
      // the references but lost the failure would look like a success.
      expect(pooled.unscanned.map((file) => [file.relative, file.reason])).toEqual([
        ['guide.md', 'parse-failed'],
      ]);
      expect(pooled.unscanned).toEqual(unpooled.unscanned);
    },
    WORKER_TIMEOUT_MS,
  );

  it(
    'produces byte-identical output over a mixed tree, which is rule 11',
    async () => {
      // Enough files that the batches interleave and completions arrive out of order.
      // Output order comes from `Promise.all` preserving INPUT order, so an implementation
      // that resolved in completion order would fail here and nowhere else.
      const files: Record<string, string> = {};
      const sourceFiles = [];
      for (let index = 0; index < 60; index++) {
        const name = `page-${String(index).padStart(3, '0')}.md`;
        files[`/repo/${name}`] = `![img](img/${index}.png)\n\ntext mentioning hero.png\n`;
        sourceFiles.push(sourceFile(name, 'markdown'));
      }
      // One that throws, in the middle, so the failure path is inside the interleaving.
      files['/repo/page-030.md'] = PARTIAL_FIXTURE;

      const options = {
        sourceFiles,
        adapters: core.defaultAdapters,
        readFile: filesystem(files),
        assetBasenames: new Set(['hero.png']),
      };

      const unpooled = await core.scanSources(options);
      const pooled = await core.scanSources({ ...options, pool: { workers: 3, minFiles: 1 } });

      expect(pooled.pool.engaged).toBe(true);
      expect(pooled.references).toEqual(unpooled.references);
      expect(pooled.unscanned).toEqual(unpooled.unscanned);
      // The mention pass moved to the workers too (it is 485 ms of `scan` in CI and the
      // same per-file synchronous shape), so it needs the same equality.
      expect(pooled.mentions).toEqual(unpooled.mentions);
      expect(pooled.mentions.length).toBeGreaterThan(0);
    },
    WORKER_TIMEOUT_MS,
  );
});

describe('when the pool does not engage, it says which reason', () => {
  it(
    'refuses a custom adapter rather than scanning half the files with a different one',
    async () => {
      // 🔴 A worker imports `defaultAdapters` and matches on `adapterId`, because an
      // adapter is an object of functions and functions do not clone. Pooling only the
      // files whose adapter happens to be a default one would mean two files in the same
      // scan were read by adapters chosen on different grounds — a correctness change
      // wearing a performance change's clothes.
      const custom = { id: 'custom', extensions: ['.xyz'], findReferences: () => [] };
      const result = await core.scanSources({
        sourceFiles: [sourceFile('a.xyz', 'custom')],
        adapters: [custom],
        readFile: filesystem({ '/repo/a.xyz': 'anything' }),
        pool: { workers: 2, minFiles: 1 },
      });

      expect(result.pool.engaged).toBe(false);
      expect(result.pool.reason).toBe('custom-adapter');
    },
    WORKER_TIMEOUT_MS,
  );

  it(
    'stays on the main thread below the engagement floor',
    async () => {
      const result = await core.scanSources({
        sourceFiles: [sourceFile('guide.md', 'markdown')],
        adapters: core.defaultAdapters,
        readFile: filesystem({ '/repo/guide.md': '![a](a.png)\n' }),
        pool: { workers: 2, minFiles: 10 },
      });

      // R127: a watch-mode rescan of three files must not pay for four workers.
      expect(result.pool.engaged).toBe(false);
      expect(result.pool.reason).toBe('below-floor');
      expect(result.references.map((reference) => reference.rawPath)).toEqual(['a.png']);
    },
    WORKER_TIMEOUT_MS,
  );

  it(
    'says so when nobody asked, which is the library default',
    async () => {
      const result = await core.scanSources({
        sourceFiles: [sourceFile('guide.md', 'markdown')],
        adapters: core.defaultAdapters,
        readFile: filesystem({ '/repo/guide.md': '![a](a.png)\n' }),
      });

      // R127: CLI default, library opt-in. `upfly-core` runs inside a VS Code extension
      // host, and spawning OS threads in somebody else's process is a side effect nobody
      // asked for.
      expect(result.pool.engaged).toBe(false);
      expect(result.pool.reason).toBe('not-requested');
      expect(result.pool.workers).toBe(0);
    },
    WORKER_TIMEOUT_MS,
  );
});

describe('a worker that dies', () => {
  it(
    'hands its tasks back instead of hanging the audit forever',
    async () => {
      // 🔴 **THIS IS A HANG, WHICH IS WORSE THAN A CRASH.** `postMessage` to a dead worker
      // throws nothing and delivers nothing, so before the fix every task round-robin sent
      // to a dead worker sat unresolved forever and the audit simply never returned, with
      // no error anywhere. Rejecting the *currently* pending tasks was not enough — the
      // ones posted AFTERWARDS are the ones that hang.
      //
      // ⚠️ Found for real: a worker inherited the parent's `execArgv` and died at startup
      // with a message about a flag that had nothing to do with this package. The pool now
      // passes `execArgv: []`, and this test is the assertion that the death itself is
      // survivable however it happens.
      const brokenWorker = new URL('./broken-worker.mjs', import.meta.url);
      const pool = core.createScanPool(2, undefined, brokenWorker);
      expect(pool).not.toBeNull();
      if (pool === null) return;

      const file = sourceFile('guide.md', 'markdown');
      // More tasks than workers, so some are posted after both workers are already dead.
      const results = await Promise.all(
        Array.from({ length: 8 }, () => pool.run(file, '![a](a.png)')),
      );

      // Every one resolved, and every one said "parse this on the main thread".
      expect(results).toHaveLength(8);
      expect(results.every((result) => result === null)).toBe(true);
      // ✅ And it is COUNTED. A pool that silently handed everything back would look
      // exactly like a pool that worked, which is rule 9's P0 in performance clothing.
      expect(pool.fellBack).toBeGreaterThan(0);

      await pool.close();
    },
    WORKER_TIMEOUT_MS,
  );
});
