import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildGraph, unreferencedAssets } from './graph.js';
import type { Asset, RawReference, Reference, UnscannedFile } from './types.js';

/**
 * The graph is pure, so these tests build references by hand rather than running
 * the pipeline. The fixture trees in `fixtures.test.ts` cover the other direction —
 * that the real adapters and the real resolver produce something this can link.
 *
 * Paths are POSIX here so the expectations read the same on both platforms; the
 * module never interprets them, it only compares and keys on them.
 */

const ROOT = '/repo';

function asset(relative: string, bytes = 100): Asset {
  return {
    path: `${ROOT}/${relative}`,
    relative,
    extension: relative.slice(relative.lastIndexOf('.')),
    bytes,
  };
}

function raw(file: string, rawPath: string, start = 0): RawReference {
  return {
    file: `${ROOT}/${file}`,
    start,
    end: start + rawPath.length,
    rawPath,
    kind: 'attr',
    ceiling: 'high',
    asserted: true,
  };
}

function resolved(file: string, rawPath: string, target: string, start = 0): Reference {
  return {
    ...raw(file, rawPath, start),
    resolution: 'resolved',
    confidence: 'high',
    resolvedPath: `${ROOT}/${target}`,
    resolvedVia: 'file',
  };
}

function pattern(file: string, rawPath: string, targets: [string, ...string[]]): Reference {
  return {
    ...raw(file, rawPath),
    ceiling: 'medium',
    resolution: 'resolved-pattern',
    confidence: 'medium',
    resolvedPaths: targets.map((target) => `${ROOT}/${target}`) as [string, ...string[]],
    resolvedVia: 'file',
  };
}

function unlinked(
  file: string,
  rawPath: string,
  resolution: 'dynamic' | 'broken' | 'discarded' | 'unresolved-alias',
): Reference {
  return { ...raw(file, rawPath), resolution, confidence: 'unsafe', resolvedPath: null };
}

function build(input: {
  assets?: readonly Asset[];
  references?: readonly Reference[];
  unscannedFiles?: readonly UnscannedFile[];
}) {
  return buildGraph({
    root: ROOT,
    assets: input.assets ?? [],
    references: input.references ?? [],
    unscannedFiles: input.unscannedFiles ?? [],
  });
}

/** A root with the platform's own separators, so `path.relative` behaves natively. */
function platformRoot(): string {
  return process.platform === 'win32' ? 'C:\\repo' : '/repo';
}

/** An unlinked reference in a named file — used where only the file matters. */
function brokenAt(file: string): Reference {
  return {
    ...raw('placeholder.html', 'a.png'),
    file,
    resolution: 'broken',
    confidence: 'unsafe',
    resolvedPath: null,
  };
}

function unscanned(relative: string, reason: UnscannedFile['reason'] = 'unclaimed-extension') {
  return {
    path: `${ROOT}/${relative}`,
    relative,
    extension: relative.includes('.') ? relative.slice(relative.lastIndexOf('.')) : '',
    reason,
    detail: '',
  };
}

describe('buildGraph', () => {
  it('links each reference to the asset it resolved to', () => {
    const graph = build({
      assets: [asset('hero.png'), asset('logo.png')],
      references: [resolved('index.html', './hero.png', 'hero.png')],
    });

    expect(graph.assets.map((node) => [node.asset.relative, node.references.length])).toEqual([
      ['hero.png', 1],
      ['logo.png', 0],
    ]);
  });

  it('links a pattern reference to every asset it matched', () => {
    // The whole point of `resolved-pattern`. Linking only the first match would
    // leave the other two looking unreferenced and produce two false `dead`
    // findings — the same failure the `broken` rules exist to prevent, in a
    // different costume.
    const graph = build({
      assets: [asset('img/a.png'), asset('img/b.png'), asset('img/c.png'), asset('other.png')],
      references: [
        pattern('Gallery.jsx', './img/${name}.png', ['img/a.png', 'img/b.png', 'img/c.png']),
      ],
    });

    expect(unreferencedAssets(graph).map((node) => node.asset.relative)).toEqual(['other.png']);
  });

  it('does not link an out-of-scope reference', () => {
    // It points at a real file, but one that is not in the asset set at all, so
    // there is no node for it and nothing for it to keep alive.
    const graph = build({
      assets: [asset('hero.png')],
      references: [
        {
          ...raw('index.html', '../legacy/old.png'),
          resolution: 'out-of-scope',
          confidence: 'unsafe',
          resolvedPath: '/repo/legacy/old.png',
          exclusionReason: "the ignore rule 'legacy/'",
        },
      ],
    });

    expect(unreferencedAssets(graph)).toHaveLength(1);
    expect(graph.byResolution['out-of-scope']).toHaveLength(1);
  });

  it('counts several references to one asset', () => {
    const graph = build({
      assets: [asset('hero.png')],
      references: [
        resolved('index.html', './hero.png', 'hero.png'),
        resolved('about.html', './hero.png', 'hero.png'),
      ],
    });

    expect(graph.assets[0]?.references).toHaveLength(2);
  });

  it('keeps every reference, linked or not', () => {
    // Rule 9 at the layer most likely to lose one.
    const references = [
      resolved('index.html', './hero.png', 'hero.png'),
      unlinked('index.html', './missing.png', 'broken'),
      unlinked('theme.scss', 'url($hero)', 'dynamic'),
      unlinked('package.json', 'dist/main.js', 'discarded'),
      unlinked('App.tsx', '@/assets/logo.png', 'unresolved-alias'),
    ];

    const graph = build({ assets: [asset('hero.png')], references });

    expect(graph.references).toHaveLength(references.length);
    const bucketed = Object.values(graph.byResolution).flat();
    expect(bucketed).toHaveLength(references.length);
  });

  it('buckets every outcome, including the ones with nothing in them', () => {
    const graph = build({});

    expect(Object.keys(graph.byResolution).sort()).toEqual([
      'broken',
      'discarded',
      'dynamic',
      'out-of-scope',
      'resolved',
      'resolved-pattern',
      'unresolved-alias',
    ]);
  });

  it('throws when a reference links to an asset that is not in the set', () => {
    // Unreachable in one run, reachable the moment references are resolved against
    // a cached asset set — which is what the editor integration will do. The quiet
    // version of this bug is a phantom dead asset.
    expect(() =>
      build({
        assets: [asset('hero.png')],
        references: [resolved('index.html', './gone.png', 'gone.png')],
      }),
    ).toThrow(expect.objectContaining({ code: 'GRAPH_UNKNOWN_ASSET' }));
  });

  describe('ordering', () => {
    it('sorts assets by their relative path', () => {
      const graph = build({ assets: [asset('z.png'), asset('a.png'), asset('m/b.png')] });

      expect(graph.assets.map((node) => node.asset.relative)).toEqual([
        'a.png',
        'm/b.png',
        'z.png',
      ]);
    });

    it('sorts references by file and then by position', () => {
      const graph = build({
        assets: [asset('hero.png')],
        references: [
          resolved('b.html', './hero.png', 'hero.png', 50),
          resolved('a.html', './hero.png', 'hero.png', 90),
          resolved('a.html', './hero.png', 'hero.png', 10),
        ],
      });

      expect(graph.references.map((reference) => [reference.file, reference.start])).toEqual([
        ['/repo/a.html', 10],
        ['/repo/a.html', 90],
        ['/repo/b.html', 50],
      ]);
    });

    it('orders by the POSIX-relative path, not by the raw `file` field', () => {
      // The ordering bug that would be invisible otherwise. `/` is 0x2F and `\` is
      // 0x5C, so they fall on opposite sides of the alphanumerics. Sorting the raw
      // native `file` field puts `dir/a.html` before `dirZ.html` on Linux and
      // *after* it on Windows — two machines, two orderings, and rule 11's
      // byte-identical report quietly stops being true.
      //
      // The correct order below is the same on both platforms, but the test only
      // has teeth on Windows: on POSIX the relative path is a suffix of the
      // absolute one, so the two implementations cannot disagree. It runs
      // everywhere because the Windows CI cells are where it earns its keep.
      const root = platformRoot();
      const nested = join(root, 'dir', 'a.html');
      const sibling = join(root, 'dirZ.html');

      const graph = buildGraph({
        root,
        assets: [],
        references: [brokenAt(sibling), brokenAt(nested)],
        unscannedFiles: [],
      });

      expect(graph.references.map((reference) => reference.file)).toEqual([nested, sibling]);
    });

    it('orders each asset node the same way', () => {
      const graph = build({
        assets: [asset('hero.png')],
        references: [
          resolved('b.html', './hero.png', 'hero.png'),
          resolved('a.html', './hero.png', 'hero.png'),
        ],
      });

      expect(graph.assets[0]?.references.map((reference) => reference.file)).toEqual([
        '/repo/a.html',
        '/repo/b.html',
      ]);
    });

    it('produces the same graph however the inputs are ordered', () => {
      // Rule 11: the report is a function of the repository, not of iteration order.
      const assets = [asset('a.png'), asset('b.png')];
      const references = [
        resolved('x.html', './a.png', 'a.png'),
        resolved('y.html', './b.png', 'b.png'),
      ];
      const files = [unscanned('a.vue'), unscanned('b.njk')];

      const forwards = build({ assets, references, unscannedFiles: files });
      const backwards = build({
        assets: [...assets].reverse(),
        references: [...references].reverse(),
        unscannedFiles: [...files].reverse(),
      });

      expect(backwards).toEqual(forwards);
    });
  });

  describe('unscanned files', () => {
    it('carries both sources through as one list', () => {
      // Discovery's unclaimed extensions and scan's parse failures are the same
      // condition to the audit: we did not learn what the file references.
      const graph = build({
        unscannedFiles: [unscanned('config.yaml'), unscanned('broken.scss', 'parse-failed')],
      });

      expect(graph.unscannedFiles.map((file) => [file.relative, file.reason])).toEqual([
        ['broken.scss', 'parse-failed'],
        ['config.yaml', 'unclaimed-extension'],
      ]);
    });

    it('counts them by extension, including files without one', () => {
      const graph = build({
        unscannedFiles: [
          unscanned('a.vue'),
          unscanned('b.vue'),
          unscanned('c.yaml'),
          unscanned('LICENSE'),
        ],
      });

      expect(graph.unscannedExtensions).toEqual([
        { ext: '', fileCount: 1 },
        { ext: '.vue', fileCount: 2 },
        { ext: '.yaml', fileCount: 1 },
      ]);
    });

    it('is empty when every file was read', () => {
      // The only case in which a `dead` finding can be made confidently without a
      // sweep — and, on real repositories, a rare one.
      expect(build({ assets: [asset('a.png')] }).unscannedExtensions).toEqual([]);
    });
  });
});

describe('unreferencedAssets', () => {
  it('returns the assets nothing points at, in report order', () => {
    const graph = build({
      assets: [asset('used.png'), asset('orphan.png'), asset('another.png')],
      references: [resolved('index.html', './used.png', 'used.png')],
    });

    expect(unreferencedAssets(graph).map((node) => node.asset.relative)).toEqual([
      'another.png',
      'orphan.png',
    ]);
  });

  it('returns nothing when every asset is referenced', () => {
    const graph = build({
      assets: [asset('hero.png')],
      references: [resolved('index.html', './hero.png', 'hero.png')],
    });

    expect(unreferencedAssets(graph)).toEqual([]);
  });
});
