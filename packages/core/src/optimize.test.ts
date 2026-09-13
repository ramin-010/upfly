/**
 * The wiring, against an in-memory disk and a fake encoder.
 *
 * What these ask is whether the five stages are joined up correctly: that the plan is
 * the same on a dry run and an applied one, that staged bytes land where the
 * transaction expects them, and that a refusal stops everything.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AuditResult } from './audit.js';
import { buildGraph } from './graph.js';
import { LOCK_PATH } from './lock.js';
import { MANIFEST_PATH } from './manifest.js';
import { type OptimizeInput, alwaysMeasureFor, newRunId, optimize } from './optimize.js';
import type { AssetProbe, ImageProbe } from './probe.js';
import { type FileStore, type RunContext, commit } from './transaction.js';
import type { Asset, RawReference, Reference } from './types.js';

const ROOT = '/repo';
const RUN_ID = '2026-01-01T000000-abcd';

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function asset(relative: string, bytes = 10_000): Asset {
  return {
    path: `${ROOT}/${relative}`,
    relative,
    extension: relative.slice(relative.lastIndexOf('.')),
    bytes,
  };
}

const SOURCE = 'import logo from "./logo.png";\n';

const RAW: Omit<RawReference, 'file' | 'rawPath' | 'start' | 'end'> = {
  kind: 'attr',
  ceiling: 'high',
  asserted: true,
};

function resolved(file: string, rawPath: string, target: string, text = SOURCE): Reference {
  // Found in the text rather than written down. A hardcoded offset that is wrong by
  // six characters still produces a rewrite, and the rewrite is mangled rather than
  // absent, which is the exact failure mode the offsets exist to avoid.
  const start = text.indexOf(rawPath);
  return {
    ...RAW,
    file: `${ROOT}/${file}`,
    rawPath,
    start,
    end: start + rawPath.length,
    resolution: 'resolved',
    confidence: 'high',
    resolvedPath: `${ROOT}/${target}`,
    resolvedVia: 'file',
  } as Reference;
}

function probeOf(relative: string, over: Partial<AssetProbe> = {}): AssetProbe {
  return {
    relative,
    metadata: { width: 100, height: 100, format: 'png', pages: 1 },
    encoded: [{ format: 'webp', bytes: 2_000, quality: 80 }],
    skipped: [],
    ...over,
  };
}

/** An in-memory disk, plus a record of every encode the probe was asked for. */
function harness(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial));
  const encodes: { path: string; destination: string; animated: boolean }[] = [];

  const store: FileStore = {
    hashAlgorithm: 'sha256',
    async hash(path) {
      const text = files.get(path);
      return text === undefined ? null : sha(text);
    },
    async readText(path) {
      const text = files.get(path);
      if (text === undefined) throw new Error(`no such file: ${path}`);
      return text;
    },
    async writeText(path, text) {
      files.set(path, text);
    },
    // Real exclusive semantics, not a stub that always succeeds. A memory store that
    // happily overwrote here would let every lock test pass against a lock that could
    // never refuse — the fake would be asserting its own politeness.
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

  const probe: ImageProbe = {
    quality: { webp: 80, avif: 75 },
    metadata: async () => ({ width: 100, height: 100, format: 'png', pages: 1 }),
    encodedBytes: async () => 2_000,
    async encodeToFile({ path, destination, animated }) {
      encodes.push({ path, destination, animated });
      // The destination is absolute; the store speaks in project-relative paths.
      files.set(destination.slice(`${ROOT}/`.length), `WEBP(${path})`);
      return 2_000;
    },
  };

  return { files, store, probe, encodes };
}

function inputFor(
  over: Partial<OptimizeInput> & Pick<OptimizeInput, 'store' | 'probe'>,
): OptimizeInput {
  const assets = [asset('src/logo.png')];
  const references = [resolved('src/App.jsx', './logo.png', 'src/logo.png')];
  const audit: AuditResult = {
    findings: [],
    publicDirDeadCount: 0,
    conventionLinked: [],
    unreadableSources: [],
    probed: true,
    duplicatesChecked: false,
  };

  return {
    graph: buildGraph({ root: ROOT, assets, references, unscannedFiles: [] }),
    audit,
    probes: [probeOf('src/logo.png')],
    servingRoots: { dirs: ['public'], declared: true },
    format: 'webp',
    publicDir: 'public',
    publicPolicy: 'keep-original',
    apply: true,
    runId: RUN_ID,
    now: () => '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('newRunId', () => {
  it('is sortable, readable, and not derived from content', () => {
    const id = newRunId(new Date('2026-09-12T02:15:00.000Z'), () => 0.5);

    expect(id).toMatch(/^\d{8}T\d{6}-[0-9a-f]{4}$/);
  });

  it('differs between two runs over an unchanged repository', () => {
    // A content-derived name would collide, and the second run would write into the
    // first one's directory.
    const at = new Date('2026-09-12T02:15:00.000Z');

    expect(newRunId(at, () => 0.1)).not.toBe(newRunId(at, () => 0.9));
  });
});

describe('optimize', () => {
  it('makes every decision on a dry run and writes nothing', async () => {
    const store = harness({ 'src/App.jsx': SOURCE, 'src/logo.png': 'PNG' });
    const before = new Map(store.files);

    const result = await optimize(inputFor({ ...store, apply: false }));

    expect(result.plan.conversions).toHaveLength(1);
    expect(result.plan.rewrites).toHaveLength(1);
    expect(result.manifest).toBeNull();
    expect([...store.files]).toEqual([...before]);
    expect(store.encodes).toEqual([]);
  });

  it('reaches the same plan whether or not it applies it', async () => {
    // A preview that computes something different from the run is a lie in the shape
    // of a preview, so the decisions have to come out of one code path.
    const dry = harness({ 'src/App.jsx': SOURCE, 'src/logo.png': 'PNG' });
    const wet = harness({ 'src/App.jsx': SOURCE, 'src/logo.png': 'PNG' });

    const dryRun = await optimize(inputFor({ ...dry, apply: false }));
    const wetRun = await optimize(inputFor({ ...wet, apply: true }));

    expect(wetRun.plan).toEqual(dryRun.plan);
  });

  it('encodes into the run directory, mirroring the project tree', async () => {
    const store = harness({ 'src/App.jsx': SOURCE, 'src/logo.png': 'PNG' });

    const result = await optimize(inputFor(store));

    // A person looking into a run directory should recognise what they are seeing.
    expect(store.encodes[0]?.destination).toBe(
      `${ROOT}/.upfly/runs/${RUN_ID}/staged/src/logo.webp`,
    );
    expect(result.runDir).toBe(`.upfly/runs/${RUN_ID}`);
  });

  it('writes the encode into place and repoints the reference at it', async () => {
    const store = harness({ 'src/App.jsx': SOURCE, 'src/logo.png': 'PNG' });

    const result = await optimize(inputFor(store));

    expect(store.files.get('src/logo.webp')).toBe(`WEBP(${ROOT}/src/logo.png)`);
    expect(store.files.get('src/App.jsx')).toBe('import logo from "./logo.webp";\n');
    expect(result.manifest?.state).toBe('committed');
    expect(store.files.has(MANIFEST_PATH)).toBe(true);
  });

  it('keeps the original under the default policy', async () => {
    const store = harness({ 'src/App.jsx': SOURCE, 'src/logo.png': 'PNG' });

    await optimize(inputFor(store));

    expect(store.files.get('src/logo.png')).toBe('PNG');
  });

  it('takes the animation flag from the measurement, not from the extension', async () => {
    // Getting this wrong writes a one-frame GIF and reports a saving only achievable
    // by destroying the animation.
    const store = harness({ 'src/App.jsx': SOURCE, 'src/logo.png': 'PNG' });

    await optimize(
      inputFor({
        ...store,
        probes: [
          probeOf('src/logo.png', {
            metadata: { width: 100, height: 100, format: 'gif', pages: 12 },
          }),
        ],
      }),
    );

    expect(store.encodes[0]?.animated).toBe(true);
  });

  it('writes nothing at all when the plan converts nothing', async () => {
    const store = harness({ 'src/App.jsx': SOURCE, 'src/logo.png': 'PNG' });
    const before = new Map(store.files);

    const result = await optimize(
      inputFor({ ...store, probes: [probeOf('src/logo.png', { encoded: [] })] }),
    );

    expect(result.plan.conversions).toEqual([]);
    expect(result.manifest).toBeNull();
    expect([...store.files]).toEqual([...before]);

    // ⚠️ An asset with no measured saving is declined with a null reason, so it does
    // not reach the report at all. That is B2's unease (f) and it is still open: the
    // audit is believed to report the same assets as `beyond-encode-cap`, and nobody
    // has checked end to end that the two land in the same place.
    expect(result.plan.declined).toEqual([]);
  });
});

describe('the pattern-target lookup', () => {
  it('returns the assets a pattern could match', () => {
    const assets = [asset('src/a.png'), asset('src/b.png')];
    const pattern = {
      ...RAW,
      file: `${ROOT}/src/App.jsx`,
      rawPath: './${name}.png',
      start: 0,
      end: 10,
      ceiling: 'medium',
      resolution: 'resolved-pattern',
      confidence: 'medium',
      resolvedPaths: [`${ROOT}/src/a.png`, `${ROOT}/src/b.png`],
      resolvedVia: 'file',
    } as unknown as Reference;

    const targets = alwaysMeasureFor(
      buildGraph({ root: ROOT, assets, references: [pattern], unscannedFiles: [] }),
    );

    expect(targets.map((target) => target.relative)).toEqual(['src/a.png', 'src/b.png']);
  });

  it('is the objects themselves, so no path convention has to line up', () => {
    // The trap this exists to remove: patternTargets returns absolute paths, the
    // planner speaks relative ones, and the probe cap is keyed on absolute. Handing
    // the probe Asset objects means there is no string to be the wrong kind.
    const assets = [asset('src/a.png')];
    const pattern = {
      ...RAW,
      file: `${ROOT}/src/App.jsx`,
      rawPath: './${name}.png',
      start: 0,
      end: 10,
      ceiling: 'medium',
      resolution: 'resolved-pattern',
      confidence: 'medium',
      resolvedPaths: [`${ROOT}/src/a.png`],
      resolvedVia: 'file',
    } as unknown as Reference;

    const [target] = alwaysMeasureFor(
      buildGraph({ root: ROOT, assets, references: [pattern], unscannedFiles: [] }),
    );

    expect(target).toBe(assets[0]);
  });
});

describe('R68: the lock covers the gap between staging and committing', () => {
  /**
   * 🔴 **The failure `commit`-scoped locking does NOT close, and the reason the lock is
   * taken in `optimize` as well.**
   *
   * `commit` holds the lock across its own two manifest writes, which closes the
   * failure exactly as R68 describes it. It leaves a second window: between this run's
   * `prepare` and its `commit`, another run can start AND FINISH completely. Its
   * committed manifest is then overwritten the moment this run resumes and writes its
   * own pending one -- and its backups are orphaned exactly as if it had been
   * interrupted mid-write. Same lost record, different route.
   *
   * Note this is NOT the case B3's fix already covers: `commit` re-verifies
   * `beforeHash`, so two runs cannot corrupt the same FILE. Two runs touching
   * different files corrupt nothing and still destroy one of the two records.
   */
  it('refuses a second run while the first is between prepare and commit', async () => {
    const project = harness({ 'src/App.jsx': SOURCE, 'src/logo.png': 'PNG' });
    let reached = (): void => {};
    const inside = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release = (): void => {};
    const suspended = new Promise<void>((resolve) => {
      release = resolve;
    });
    let armed = true;

    const suspending: FileStore = {
      ...project.store,
      async hash(path) {
        // Suspends on a staged-path hash taken AFTER the lock exists, which lands
        // inside `prepare`. `stage` hashes staged paths too and runs before the lock,
        // so keying on the path alone stopped the run in the wrong place -- caught by
        // the assertion below, which is why it asserts a position and not a feeling.
        if (armed && project.files.has(LOCK_PATH) && path.startsWith('.upfly/runs/')) {
          armed = false;
          reached();
          await suspended;
        }
        return project.store.hash(path);
      },
    };

    const running = optimize(inputFor({ ...project, store: suspending, apply: true }));
    await inside;

    // ⚠️ **The position is asserted, not assumed.** The run is past `prepare`'s first
    // staged-path check and has not written a manifest yet, which IS the gap -- and it
    // is precisely where a commit-scoped lock would not be holding anything.
    expect(project.files.has(MANIFEST_PATH)).toBe(false);

    const other: RunContext = {
      runId: 'run-other',
      runDir: '.upfly/runs/run-other',
      now: () => '2026-09-13T00:00:00.000Z',
      declined: [],
    };
    await expect(commit([], project.store, other)).rejects.toThrow(
      expect.objectContaining({ code: 'TRANSACTION_LOCKED' }),
    );

    release();
    await running;

    // And the run cleans up after itself, or the next one inherits a locked project.
    expect(project.files.has(LOCK_PATH)).toBe(false);
  });

  it('lets that same second run through once the lock is gone', async () => {
    // ⚠️ The fixture mutation, kept as a control. Without it the refusal above could
    // be caused by anything at all in a half-finished run, and would still read as
    // proof of a lock.
    const project = harness({ 'src/App.jsx': SOURCE, 'src/logo.png': 'PNG' });
    const other: RunContext = {
      runId: 'run-other',
      runDir: '.upfly/runs/run-other',
      now: () => '2026-09-13T00:00:00.000Z',
      declined: [],
    };

    await expect(commit([], project.store, other)).resolves.toMatchObject({ state: 'committed' });
  });
});
