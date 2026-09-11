import { describe, expect, it } from 'vitest';
import { buildGraph } from './graph.js';
import { type PlanInput, patternTargets, planOptimization } from './plan.js';
import type { AssetProbe } from './probe.js';
import type { Asset, RawReference, Reference } from './types.js';

const ROOT = '/repo';

function asset(relative: string, bytes = 10_000): Asset {
  return {
    path: `${ROOT}/${relative}`,
    relative,
    extension: relative.slice(relative.lastIndexOf('.')),
    bytes,
  };
}

/** A measurement that says this asset shrinks to `bytes` as webp. */
function probe(relative: string, bytes = 4_000): AssetProbe {
  return {
    relative,
    metadata: { width: 100, height: 100, format: 'png', pages: 1 },
    encoded: [{ format: 'webp', bytes, quality: 80 }],
    skipped: [],
  };
}

const RAW: Omit<RawReference, 'file' | 'rawPath' | 'start' | 'end'> = {
  kind: 'attr',
  ceiling: 'high',
  asserted: true,
};

function resolved(
  file: string,
  rawPath: string,
  target: string,
  over: Partial<Reference> = {},
): Reference {
  return {
    ...RAW,
    file: `${ROOT}/${file}`,
    rawPath,
    start: 10,
    end: 10 + rawPath.length,
    resolution: 'resolved',
    confidence: 'high',
    resolvedPath: `${ROOT}/${target}`,
    resolvedVia: 'file',
    ...over,
  } as Reference;
}

function pattern(file: string, rawPath: string, targets: readonly string[]): Reference {
  return {
    ...RAW,
    file: `${ROOT}/${file}`,
    rawPath,
    start: 10,
    end: 10 + rawPath.length,
    ceiling: 'medium',
    resolution: 'resolved-pattern',
    confidence: 'medium',
    resolvedPaths: targets.map((target) => `${ROOT}/${target}`) as [string, ...string[]],
    resolvedVia: 'file',
  } as Reference;
}

function input(over: Partial<PlanInput> & { assets: Asset[]; references: Reference[] }): PlanInput {
  return {
    graph: buildGraph({
      root: ROOT,
      assets: over.assets,
      references: over.references,
      unscannedFiles: [],
    }),
    probes: over.probes ?? over.assets.map((a) => probe(a.relative)),
    format: 'webp',
    publicDir: over.publicDir === undefined ? 'public' : over.publicDir,
    publicPolicy: over.publicPolicy ?? 'keep-original',
    hedged: over.hedged ?? new Set(),
    servingRoots: over.servingRoots ?? { dirs: ['public'], declared: false },
    ...(over.rootLinkPolicy === undefined ? {} : { rootLinkPolicy: over.rootLinkPolicy }),
  };
}

describe('the ordinary case', () => {
  it('converts a linked asset and repoints the reference that names it', () => {
    const plan = planOptimization(
      input({
        assets: [asset('src/logo.png')],
        references: [resolved('src/App.jsx', './logo.png', 'src/logo.png')],
      }),
    );

    expect(plan.conversions).toEqual([
      {
        asset: 'src/logo.png',
        target: 'src/logo.webp',
        format: 'webp',
        quality: 80,
        savedBytes: 6_000,
        replacesOriginal: false,
      },
    ]);
    expect(plan.rewrites).toEqual([
      { file: 'src/App.jsx', edits: [{ start: 10, end: 20, replacement: './logo.webp' }] },
    ]);
    expect(plan.declined).toEqual([]);
  });

  it('does not convert an asset the encode made bigger', () => {
    const plan = planOptimization(
      input({
        assets: [asset('src/logo.png', 1_000)],
        references: [resolved('src/App.jsx', './logo.png', 'src/logo.png')],
        probes: [probe('src/logo.png', 4_000)],
      }),
    );

    expect(plan.conversions).toEqual([]);
    expect(plan.rewrites).toEqual([]);
  });
});

describe('an asset nothing links to', () => {
  it('is left alone outside a public directory, with the reason recorded', () => {
    const plan = planOptimization({
      ...input({ assets: [asset('src/orphan.png')], references: [] }),
    });

    expect(plan.conversions).toEqual([]);
    expect(plan.declined).toEqual([
      {
        path: 'src/orphan.png',
        line: null,
        reason:
          'nothing links to it, so converting it would rewrite no reference and gain only bytes',
      },
    ]);
  });

  it('says so differently when something unreadable mentions it', () => {
    const plan = planOptimization(
      input({
        assets: [asset('src/maybe.png')],
        references: [],
        hedged: new Set(['src/maybe.png']),
      }),
    );

    expect(plan.declined[0]?.reason).toContain('something we could not read mentions it');
  });

  it('is still converted inside a public directory, where the original stays put', () => {
    // A public asset may be loaded by something outside the repository that no graph
    // can see. Under keep-original the original is untouched, so writing the smaller
    // file alongside it cannot break that caller.
    const plan = planOptimization(input({ assets: [asset('public/hero.png')], references: [] }));

    expect(plan.conversions.map((c) => c.asset)).toEqual(['public/hero.png']);
    expect(plan.declined).toEqual([]);
  });
});

describe('references it refuses to rewrite', () => {
  it('leaves an unsafe reference alone and says the asset moved without it', () => {
    const plan = planOptimization(
      input({
        assets: [asset('public/hero.png')],
        references: [
          resolved('src/App.jsx', './hero.png', 'public/hero.png', { confidence: 'unsafe' }),
        ],
      }),
    );

    expect(plan.rewrites).toEqual([]);
    expect(plan.declined[0]?.reason).toContain('no static path to replace');
    expect(plan.declined[0]?.reason).toContain('public/hero.png was converted');
  });

  it('leaves a speculative path that happened to resolve against the root', () => {
    const plan = planOptimization(
      input({
        assets: [asset('public/hero.png')],
        references: [
          resolved('src/data.json', './hero.png', 'public/hero.png', {
            asserted: false,
            resolvedVia: 'speculative-root',
          }),
        ],
      }),
    );

    expect(plan.rewrites).toEqual([]);
    expect(plan.declined[0]?.reason).toContain('shows the asset is alive but not that this text');
  });
});

describe('a root-relative path that resolved at the project root', () => {
  const tree = {
    assets: [asset('public/hero.png')],
    references: [
      resolved('index.html', '/hero.png', 'public/hero.png', { resolvedVia: 'project-root' }),
    ],
  };

  it('is rewritten on a project with no serving root, which is the ordinary static site', () => {
    const plan = planOptimization(
      input({ ...tree, servingRoots: { dirs: ['public'], declared: false } }),
    );

    // End derived from the path being replaced rather than written down: copying 20
    // from the case above was wrong, because `/hero.png` is nine characters and
    // `./logo.png` is ten.
    expect(plan.rewrites).toEqual([
      {
        file: 'index.html',
        edits: [{ start: 10, end: 10 + '/hero.png'.length, replacement: '/hero.webp' }],
      },
    ]);
  });

  it('is declined when a serving root was configured and the path missed it', () => {
    // The sub-case that is real but unevidenced: the path missed a root that was
    // configured, so existing at the project root may be coincidence.
    const plan = planOptimization(
      input({ ...tree, servingRoots: { dirs: ['public'], declared: true } }),
    );

    expect(plan.rewrites).toEqual([]);
    expect(plan.declined[0]?.reason).toContain('missed the configured serving root');
  });

  it('can be forced either way, because the policy is named rather than implied', () => {
    const forced = planOptimization(
      input({
        ...tree,
        servingRoots: { dirs: ['public'], declared: true },
        rootLinkPolicy: 'always',
      }),
    );
    const refused = planOptimization(
      input({
        ...tree,
        servingRoots: { dirs: ['public'], declared: false },
        rootLinkPolicy: 'never',
      }),
    );

    expect(forced.rewrites).toHaveLength(1);
    expect(refused.rewrites).toEqual([]);
  });
});

describe('a template reference standing for many assets', () => {
  const assets = [asset('public/a-light.png'), asset('public/a-dark.png', 1_000)];
  const references = [
    pattern('src/App.jsx', './a-${mode}.png', ['public/a-light.png', 'public/a-dark.png']),
  ];

  // a-dark is measured larger than its source, so it does not convert. One target
  // that does not convert is enough to make the single edit wrong for all of them.
  const probes = [probe('public/a-light.png', 4_000), probe('public/a-dark.png', 4_000)];

  it('is never rewritten when one of its targets does not convert', () => {
    const plan = planOptimization(input({ assets, references, probes }));

    expect(plan.rewrites).toEqual([]);
    expect(plan.declined.map((d) => d.reason)).toContainEqual(
      expect.stringContaining('matches 2 assets and 1 of them do not convert'),
    );
  });

  it('still converts the ones that convert under keep-original, and says the reference stayed', () => {
    const plan = planOptimization(input({ assets, references, probes }));

    // The originals survive, so the template keeps resolving. Saying nothing here
    // would let a reader take "converted" to mean the reference now points at it.
    expect(plan.conversions.map((c) => c.asset)).toEqual(['public/a-light.png']);
    expect(plan.declined.some((d) => d.reason.includes('would break the reference'))).toBe(true);
  });

  it('withdraws the conversions too under replace, where the originals would go', () => {
    const plan = planOptimization(input({ assets, references, probes, publicPolicy: 'replace' }));

    expect(plan.conversions).toEqual([]);
  });

  it('declines a template whose targets all convert, because the text is not a path', () => {
    const plan = planOptimization(
      input({
        assets,
        references,
        probes: [probe('public/a-light.png', 4_000), probe('public/a-dark.png', 400)],
      }),
    );

    expect(plan.conversions).toHaveLength(2);
    expect(plan.rewrites).toEqual([]);
    expect(plan.declined.some((d) => d.reason.includes('assembled at runtime'))).toBe(true);
  });

  it('names every asset a pattern could match, so a caller can measure exactly those', () => {
    const graph = buildGraph({ root: ROOT, assets, references, unscannedFiles: [] });

    expect(patternTargets(graph)).toEqual([
      `${ROOT}/public/a-dark.png`,
      `${ROOT}/public/a-light.png`,
    ]);
  });
});

describe('the public policy', () => {
  it('marks a public asset for replacement only when asked', () => {
    const tree = {
      assets: [asset('public/hero.png')],
      references: [resolved('index.html', '/hero.png', 'public/hero.png')],
    };

    expect(planOptimization(input(tree)).conversions[0]?.replacesOriginal).toBe(false);
    expect(
      planOptimization(input({ ...tree, publicPolicy: 'replace' })).conversions[0]
        ?.replacesOriginal,
    ).toBe(true);
  });

  it('never replaces an original outside the public directory', () => {
    const plan = planOptimization(
      input({
        assets: [asset('src/logo.png')],
        references: [resolved('src/App.jsx', './logo.png', 'src/logo.png')],
        publicPolicy: 'replace',
      }),
    );

    expect(plan.conversions[0]?.replacesOriginal).toBe(false);
  });
});

describe('everything declined carries a reason', () => {
  it('has no empty reasons anywhere in a plan that declines several things', () => {
    const plan = planOptimization(
      input({
        assets: [asset('src/orphan.png'), asset('public/hero.png')],
        references: [
          resolved('src/App.jsx', './hero.png', 'public/hero.png', { confidence: 'unsafe' }),
        ],
      }),
    );

    expect(plan.declined.length).toBeGreaterThan(1);
    for (const item of plan.declined) {
      expect(item.reason.length).toBeGreaterThan(20);
      expect(item.path).not.toBe('');
    }
  });
});

describe('refusing to plan a run whose serving root is unknown', () => {
  function unresolvedRootRelative(n: number): Reference[] {
    return Array.from(
      { length: n },
      (_, index) =>
        ({
          ...RAW,
          file: `${ROOT}/index.html`,
          rawPath: `/missing${index}.png`,
          start: index * 40,
          end: index * 40 + 10,
          resolution: 'broken',
          confidence: 'unsafe',
          resolvedPath: null,
        }) as Reference,
    );
  }

  it('returns a refusal rather than throwing, so the caller is holding something', () => {
    // R49 part 3. A thrown error leaves a user with nothing; a returned refusal is a
    // finding with a reason, which is what rule 9 asks for.
    const plan = planOptimization(
      input({ assets: [asset('src/logo.png')], references: unresolvedRootRelative(20) }),
    );

    expect(plan.refusal).toMatchObject({
      code: 'serving-root-unknown',
      linked: 0,
      checkable: 20,
    });
    expect(plan.refusal?.reason).toContain('Declare the directory your site serves from');
  });

  it('plans nothing at all, so a caller that ignores the refusal writes nothing', () => {
    const plan = planOptimization(
      input({ assets: [asset('src/logo.png')], references: unresolvedRootRelative(20) }),
    );

    expect(plan.conversions).toEqual([]);
    expect(plan.rewrites).toEqual([]);
    expect(plan.declined).toEqual([]);
  });

  it('leaves an ordinary plan with no refusal on it', () => {
    const plan = planOptimization(
      input({
        assets: [asset('src/logo.png')],
        references: [resolved('src/App.jsx', './logo.png', 'src/logo.png')],
      }),
    );

    expect(plan.refusal).toBeNull();
    expect(plan.conversions).toHaveLength(1);
  });
});
