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
  shape: 'html.img.src',
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
  const tree = new Map(Object.entries(initial));
  const encodes: { path: string; destination: string; animated: boolean }[] = [];

  const store: FileStore = {
    hashAlgorithm: 'sha256',
    async hash(path) {
      const text = tree.get(path);
      return text === undefined ? null : sha(text);
    },
    async readText(path) {
      const text = tree.get(path);
      if (text === undefined) throw new Error(`no such file: ${path}`);
      return text;
    },
    async writeText(path, text) {
      tree.set(path, text);
    },
    // Real exclusive semantics, not a stub that always succeeds. A memory store that
    // happily overwrote here would let every lock test pass against a lock that could
    // never refuse — the fake would be asserting its own politeness.
    async createExclusive(path, text) {
      if (tree.has(path)) return false;
      tree.set(path, text);
      return true;
    },
    async copy(from, to) {
      const text = tree.get(from);
      if (text === undefined) throw new Error(`no such file: ${from}`);
      tree.set(to, text);
    },
    async remove(path) {
      tree.delete(path);
    },
  };

  const probe: ImageProbe = {
    quality: { webp: 80, avif: 75 },
    metadata: async () => ({ width: 100, height: 100, format: 'png', pages: 1 }),
    encodedBytes: async () => 2_000,
    async encodeToFile({ path, destination, animated }) {
      encodes.push({ path, destination, animated });
      // The destination is absolute; the store speaks in project-relative paths.
      tree.set(destination.slice(`${ROOT}/`.length), `WEBP(${path})`);
      return 2_000;
    },
  };

  return { tree, store, probe, encodes };
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
    // R77's haystack. Defaults to the one file these fixtures hold a reference in; a
    // test that cares passes its own.
    files: ['src/App.jsx'],
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
    const before = new Map(store.tree);

    const result = await optimize(inputFor({ ...store, apply: false }));

    expect(result.plan.conversions).toHaveLength(1);
    expect(result.plan.rewrites).toHaveLength(1);
    expect(result.manifest).toBeNull();
    expect([...store.tree]).toEqual([...before]);
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

    expect(store.tree.get('src/logo.webp')).toBe(`WEBP(${ROOT}/src/logo.png)`);
    expect(store.tree.get('src/App.jsx')).toBe('import logo from "./logo.webp";\n');
    expect(result.manifest?.state).toBe('committed');
    expect(store.tree.has(MANIFEST_PATH)).toBe(true);
  });

  it('keeps the original under the default policy', async () => {
    const store = harness({ 'src/App.jsx': SOURCE, 'src/logo.png': 'PNG' });

    await optimize(inputFor(store));

    expect(store.tree.get('src/logo.png')).toBe('PNG');
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
    const before = new Map(store.tree);

    const result = await optimize(
      inputFor({ ...store, probes: [probeOf('src/logo.png', { encoded: [] })] }),
    );

    expect(result.plan.conversions).toEqual([]);
    expect(result.manifest).toBeNull();
    expect([...store.tree]).toEqual([...before]);

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
        if (armed && project.tree.has(LOCK_PATH) && path.startsWith('.upfly/runs/')) {
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
    expect(project.tree.has(MANIFEST_PATH)).toBe(false);

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
    expect(project.tree.has(LOCK_PATH)).toBe(false);
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

describe('R77 — replace refuses to delete an original a mention would outlive', () => {
  /**
   * A served asset, one reference the engine found, and whatever else is on disk.
   *
   * `publicDir: 'public'` with `publicPolicy: 'replace'` is what makes the original a
   * deletion candidate; outside a served directory nothing is deleted and R77 does not
   * apply.
   */
  function servedProject(tree: Record<string, string>, files: readonly string[]) {
    const html = tree['index.html'] ?? '';
    const assets = [asset('public/logo.png')];
    const references = [resolved('index.html', '/logo.png', 'public/logo.png', html)];
    const project = harness(tree);

    return {
      ...project,
      input: inputFor({
        ...project,
        files,
        graph: buildGraph({ root: ROOT, assets, references, unscannedFiles: [] }),
        probes: [probeOf('public/logo.png')],
        publicPolicy: 'replace' as const,
        publicDir: 'public',
        servingRoots: { dirs: ['public'], declared: true },
        apply: false,
      }),
    };
  }

  it('converts normally when the only mention is one it will rewrite', async () => {
    // 🔴 **The trap this test exists for.** At plan time EVERY mention still reads as the
    // old path, including the reference the run is about to repoint. A guard that did not
    // exclude those would refuse every conversion it ever looked at — and a guard that
    // always fires gets deleted by the next person, which is worse than not having it.
    const { input } = servedProject(
      { 'index.html': '<img src="/logo.png">', 'public/logo.png': 'PNG' },
      ['index.html'],
    );

    const result = await optimize(input);

    expect(result.plan.conversions.map((conversion) => conversion.asset)).toEqual([
      'public/logo.png',
    ]);
    expect(result.plan.conversions[0]?.replacesOriginal).toBe(true);
  });

  it('refuses the conversion when a mention survives in a file nothing parses', async () => {
    // The measured case, in miniature: `scratch-www` had the same shape in custom JSX
    // props. The reference in `index.html` is rewritten; the one in `deploy.yml` is not,
    // and deleting the original would make it a 404.
    const { input } = servedProject(
      {
        'index.html': '<img src="/logo.png">',
        'deploy.yml': 'banner: /logo.png\n',
        'public/logo.png': 'PNG',
      },
      ['index.html', 'deploy.yml'],
    );

    const result = await optimize(input);

    expect(result.plan.conversions).toEqual([]);
    // 🔴 And it is REPORTED, not merely skipped — rule 9. The reason names the trade.
    const declined = result.plan.declined.find((entry) => entry.path === 'public/logo.png');
    // 🔴 It must name WHERE. A reason that says a mention survives *somewhere* leaves the
    // user to grep for a path this engine had already located.
    expect(declined?.reason).toContain('deploy.yml:1');
    expect(declined?.reason).toContain('cannot rewrite');
  });

  it('does not refuse under keep-original, where nothing is deleted', async () => {
    // 🔴 The other half of the trade. With the original left on disk the surviving mention
    // still resolves, so refusing would cost a saving to prevent nothing. Same tree as the
    // test above, one policy different, opposite answer.
    const { input } = servedProject(
      {
        'index.html': '<img src="/logo.png">',
        'deploy.yml': 'banner: /logo.png\n',
        'public/logo.png': 'PNG',
      },
      ['index.html', 'deploy.yml'],
    );

    const result = await optimize({ ...input, publicPolicy: 'keep-original' });

    expect(result.plan.conversions.map((conversion) => conversion.asset)).toEqual([
      'public/logo.png',
    ]);
  });

  it('guards a DRY RUN identically, because the preview must be the decisions', async () => {
    // `OptimizeResult.plan` is documented as identical on a dry run and an applied one.
    // A guard that fired only on apply would quietly break that, and the preview would
    // promise a conversion the real run refuses.
    const tree = {
      'index.html': '<img src="/logo.png">',
      'deploy.yml': 'banner: /logo.png\n',
      'public/logo.png': 'PNG',
    };
    const dry = servedProject(tree, ['index.html', 'deploy.yml']);
    const wet = servedProject(tree, ['index.html', 'deploy.yml']);

    const preview = await optimize({ ...dry.input, apply: false });
    const applied = await optimize({ ...wet.input, apply: true });

    expect(preview.plan.conversions).toEqual([]);
    expect(applied.plan.conversions).toEqual([]);
    // Nothing was written, because there was nothing left to do.
    expect(wet.encodes).toEqual([]);
  });

  it('searches files the graph never saw, which is the whole point', async () => {
    // ⚠️ Premise, asserted: `deploy.yml` holds no reference the engine recognises, so it
    // appears nowhere in the graph. A haystack derived from the graph would not contain
    // it, and the guard would pass — which is the defect R77 exists to close.
    const { input } = servedProject(
      {
        'index.html': '<img src="/logo.png">',
        'deploy.yml': 'banner: /logo.png\n',
        'public/logo.png': 'PNG',
      },
      ['index.html', 'deploy.yml'],
    );
    const referencedFiles = new Set(input.graph.references.map((reference) => reference.file));
    expect(referencedFiles.has(`${ROOT}/deploy.yml`)).toBe(false);

    expect((await optimize(input)).plan.conversions).toEqual([]);
  });
});

describe('replace at the seam: a new file only where a reference moves to it, a delete only where all do', () => {
  /**
   * The operations `optimize` emits, not only the plan: `stage` turns a conversion into a
   * `create` and `replacesOriginal` into a `delete`, and the manifest records every
   * operation a run committed. So each test runs an applied `replace` over one in-memory
   * project holding every row of the rule, and reads the manifest and the disk afterwards.
   *
   * | row | asset | expected |
   * |---|---|---|
   * | every reference moves | `logo.png`, one literal | converted, original deleted |
   * | some move, some still need it | `theme-light.png`, a literal and the template | converted, original kept |
   * | linked only through references that stay | `theme-dark.png` (template), `icon-16/32.png` (chain), `hero.png` (refused literal), `mark.png` (no extension) | not converted |
   * | linked by nothing | `orphan.png` | not converted |
   *
   * `logo.png` is the positive control. A fix that simply switched `replace` off would
   * pass every "not deleted" test here, and fails that one.
   */
  const INDEX = '<img src="/logo.png"><img src="/public/h%65ro.png"><img src="/mark">\n';
  const ABOUT = '<img src="/theme-light.png">\n';
  const THEME = 'const src = `/theme-${mode}.png`;\n';
  const CHAIN = "const icon = '/icon-' + size + '.png';\n";
  const PUBLIC = [
    'public/hero.png',
    'public/icon-16.png',
    'public/icon-32.png',
    'public/logo.png',
    'public/mark.png',
    'public/orphan.png',
    'public/theme-dark.png',
    'public/theme-light.png',
  ];
  /** Every asset nothing moves to: no new file may appear for any of them. */
  const UNUSED = [
    'public/hero.png',
    'public/icon-16.png',
    'public/icon-32.png',
    'public/mark.png',
    'public/orphan.png',
    'public/theme-dark.png',
  ];

  /** A pattern reference found in `text`, the way the resolver would hand one over. */
  function patternIn(
    file: string,
    text: string,
    rawPath: string,
    targets: readonly string[],
    over: Partial<RawReference> = {},
  ): Reference {
    const start = text.indexOf(rawPath);
    return {
      ...RAW,
      file: `${ROOT}/${file}`,
      rawPath,
      start,
      end: start + rawPath.length,
      ceiling: 'medium',
      resolution: 'resolved-pattern',
      confidence: 'medium',
      resolvedPaths: targets.map((target) => `${ROOT}/${target}`) as [string, ...string[]],
      resolvedVia: 'serving-root',
      ...over,
    } as Reference;
  }

  async function runEverything(publicPolicy: 'replace' | 'keep-original' = 'replace') {
    const tree: Record<string, string> = {
      'index.html': INDEX,
      'about.html': ABOUT,
      'src/theme.js': THEME,
      'src/icon.js': CHAIN,
    };
    for (const path of PUBLIC) tree[path] = `PNG ${path}`;
    const project = harness(tree);

    const references = [
      // Every reference moves: the positive control.
      resolved('index.html', '/logo.png', 'public/logo.png', INDEX),
      // Some move, some still need it: this literal moves, the template below does not.
      resolved('about.html', '/theme-light.png', 'public/theme-light.png', ABOUT),
      // Linked only through references that stay. A root-relative path that missed the
      // DECLARED root, so its rewrite is refused, spelled so that the text search, which
      // looks for the path as written, finds none of its spellings.
      {
        ...resolved('index.html', '/public/h%65ro.png', 'public/hero.png', INDEX),
        resolvedVia: 'project-root',
        spelling: 'percent-encoded',
      } as Reference,
      // A path with no extension to swap, so a rewrite would change nothing.
      resolved('index.html', '/mark', 'public/mark.png', INDEX),
      // A template and a `+` chain, the two spellings of a pattern.
      patternIn('src/theme.js', THEME, '/theme-${mode}.png', [
        'public/theme-light.png',
        'public/theme-dark.png',
      ]),
      patternIn(
        'src/icon.js',
        CHAIN,
        "/icon-' + size + '.png",
        ['public/icon-16.png', 'public/icon-32.png'],
        {
          kind: 'string',
          shape: 'js.concat.pattern',
          asserted: false,
          assembledPath: '/icon-${}.png',
        },
      ),
      // Linked by nothing: `public/orphan.png` is an asset with no reference at all.
    ];

    const result = await optimize(
      inputFor({
        ...project,
        graph: buildGraph({
          root: ROOT,
          assets: PUBLIC.map((path) => asset(path)),
          references,
          unscannedFiles: [],
        }),
        probes: PUBLIC.map((path) => probeOf(path)),
        files: ['about.html', 'index.html', 'src/icon.js', 'src/theme.js'],
        publicPolicy,
        publicDir: 'public',
        servingRoots: { dirs: ['public'], declared: true },
        apply: true,
      }),
    );

    const operations = result.manifest?.operations ?? [];
    const pathsOf = (kind: string) =>
      operations
        .filter((operation) => operation.kind === kind)
        .map((operation) => ('path' in operation ? operation.path : ''))
        .sort();
    return { tree: project.tree, result, creates: pathsOf('create'), deletes: pathsOf('delete') };
  }

  it('converts and deletes the original of an ordinarily rewritten literal, the positive control', async () => {
    const { tree, result, deletes, creates } = await runEverything();

    expect(result.manifest?.state).toBe('committed');
    expect(creates).toContain('public/logo.webp');
    expect(deletes).toContain('public/logo.png');
    expect(tree.has('public/logo.png')).toBe(false);
    expect(tree.get('index.html')).toContain('<img src="/logo.webp">');
  });

  it('converts and keeps the original when a literal moves and the template still needs it', async () => {
    const { tree, creates, deletes, result } = await runEverything();

    expect(creates).toContain('public/theme-light.webp');
    expect(deletes).not.toContain('public/theme-light.png');
    expect(tree.get('public/theme-light.png')).toBe('PNG public/theme-light.png');
    expect(tree.get('about.html')).toBe('<img src="/theme-light.webp">\n');
    expect(result.plan.keptOriginals).toEqual([
      {
        asset: 'public/theme-light.png',
        reason: expect.stringContaining('`src/theme.js` reaches it through `/theme-${mode}.png`'),
      },
    ]);
  });

  it('writes no new file for any asset nothing moves to, and leaves each original as it was', async () => {
    const { tree, creates, deletes } = await runEverything();

    for (const original of UNUSED) {
      const converted = original.replace(/\.png$/, '.webp');
      expect(creates, `${converted} was created`).not.toContain(converted);
      expect(tree.has(converted), `${converted} is on disk`).toBe(false);
      expect(deletes).not.toContain(original);
      expect(tree.get(original)).toBe(`PNG ${original}`);
    }
  });

  it('says why for every asset it did not convert, in the plan and in the record that outlives the run', async () => {
    const { result } = await runEverything();
    const reasons = Object.fromEntries(
      result.plan.declined.map((entry) => [entry.path, entry.reason]),
    );
    const recorded = new Set(result.manifest?.declined.map((entry) => entry.path));

    expect(reasons).toMatchObject({
      'public/hero.png': expect.stringContaining(
        '`index.html` names it as `/public/h%65ro.png`, and this run does not rewrite that reference',
      ),
      'public/icon-16.png': expect.stringContaining(
        "`src/icon.js` reaches it only through `/icon-' + size + '.png`",
      ),
      'public/mark.png': expect.stringContaining('which has no extension to change'),
      'public/orphan.png': expect.stringContaining('nothing Upfly can see links to it'),
      'public/theme-dark.png': expect.stringContaining(
        '`src/theme.js` reaches it only through `/theme-${mode}.png`',
      ),
    });
    for (const asset of UNUSED) {
      expect(reasons[asset]).toContain('used by nobody');
      expect(recorded.has(asset), `${asset} is missing from the manifest's declined`).toBe(true);
    }
  });

  it('creates exactly two files, stated as the whole run', async () => {
    // So a member added to the project without a test of its own still cannot gain an
    // unused file quietly.
    const { creates } = await runEverything();

    expect(creates).toEqual(['public/logo.webp', 'public/theme-light.webp']);
  });

  it('deletes exactly one original, stated as the whole run', async () => {
    // Its own test rather than a line in the one above, because the two halves of the
    // rule are separate code. With the conversion half removed this must stay green:
    // the deletion half alone still keeps every original a reference could need.
    const { deletes } = await runEverything();

    expect(deletes).toEqual(['public/logo.png']);
  });

  it('converts every row under keep-original and deletes nothing, because that policy is unchanged', async () => {
    // The rule's scope, at the seam. Its users chose two files.
    const { creates, deletes } = await runEverything('keep-original');

    expect(creates).toEqual(PUBLIC.map((path) => path.replace(/\.png$/, '.webp')).sort());
    expect(deletes).toEqual([]);
  });
});
