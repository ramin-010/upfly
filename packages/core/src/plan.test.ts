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
  shape: 'html.img.src',
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

  it('🔴 keeps that original under replace too, because nothing has moved to the replacement (R180)', () => {
    // The vacuous member. "Every reference points at the replacement" is TRUE of an
    // asset nothing links to, so under `replace` this used to delete the original of
    // the very file the comment above converts BECAUSE something outside may load it.
    // Hedged or not: something unreadable naming it is one more reason, not the only one.
    const plan = planOptimization(
      input({
        assets: [asset('public/hero.png'), asset('public/maybe.png')],
        references: [],
        hedged: new Set(['public/maybe.png']),
        publicPolicy: 'replace',
      }),
    );

    expect(plan.conversions.map((c) => [c.asset, c.replacesOriginal])).toEqual([
      ['public/hero.png', false],
      ['public/maybe.png', false],
    ]);
    expect(plan.keptOriginals.map((kept) => kept.asset)).toEqual([
      'public/hero.png',
      'public/maybe.png',
    ]);
    for (const kept of plan.keptOriginals) {
      expect(kept.reason).toContain('nothing Upfly can see links to it');
    }
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

/** Declined reasons keyed by path, so two plans compare without depending on order. */
function reasonsByPath(plan: { declined: readonly { path: string; reason: string }[] }) {
  return Object.fromEntries(plan.declined.map((entry) => [entry.path, entry.reason]));
}

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

  it('converts the ones that convert under replace too, and keeps their originals (R181)', () => {
    // 🔴 This test asserted the opposite until R181 — every conversion withdrawn —
    // because a pattern was taken to be rewritten once all its targets convert, which
    // would have deleted the originals. No pattern is ever rewritten, and R180 keeps any
    // original a pattern still names, so a withdrawal would protect nothing.
    const plan = planOptimization(input({ assets, references, probes, publicPolicy: 'replace' }));

    expect(plan.conversions).toEqual([
      expect.objectContaining({ asset: 'public/a-light.png', replacesOriginal: false }),
    ]);
    expect(plan.keptOriginals.map((kept) => kept.asset)).toEqual(['public/a-light.png']);
  });

  it('says the reference stayed once, and truthfully, when only some targets convert', () => {
    // 🔴 Found reading `collectRewrite` for R180. A partial pattern was declined twice
    // for one reference: once as "1 of them do not convert" — true — and once as
    // "assembled at runtime … even though every asset it matches converted", which is
    // false when one of them did not. Under R181 `replace` reaches the same code, so the
    // contradiction would have doubled.
    for (const publicPolicy of ['keep-original', 'replace'] as const) {
      const plan = planOptimization(input({ assets, references, probes, publicPolicy }));
      const reasons = plan.declined
        .filter((entry) => entry.path === 'src/App.jsx')
        .map((entry) => entry.reason);

      expect(reasons).toEqual([expect.stringContaining('matches 2 assets and 1 of them')]);
    }
  });

  describe('R65 → R181: a partial pattern under replace, where nothing is withdrawn any more', () => {
    /**
     * R65 made a WITHDRAWAL reported: under `replace`, the targets that converted were
     * taken back because their originals were about to go, and until R65 they vanished
     * from the plan with nothing said about them. **R181 retires the withdrawal itself.**
     * No pattern is rewritten, and R180 keeps every original a pattern names — so the
     * targets that convert now stand, originals and all, exactly as under `keep-original`.
     *
     * What R65 protected is kept and asserted here: every asset the pattern matched is
     * accounted for, nothing is reported twice, and the plan is the same on every run.
     */
    const three = [
      asset('public/a-light.png'),
      asset('public/a-mid.png'),
      asset('public/a-dark.png', 1_000),
    ];
    const threeReferences = [
      pattern('src/App.jsx', './a-${mode}.png', [
        'public/a-light.png',
        'public/a-mid.png',
        'public/a-dark.png',
      ]),
    ];
    const threeProbes = [
      probe('public/a-light.png', 4_000),
      probe('public/a-mid.png', 4_000),
      probe('public/a-dark.png', 4_000),
    ];

    function replacePlan() {
      return planOptimization(
        input({
          assets: three,
          references: threeReferences,
          probes: threeProbes,
          publicPolicy: 'replace',
        }),
      );
    }

    it('accounts for every asset the pattern matched, with nothing left over', () => {
      // The whole claim, stated as arithmetic rather than as a spot check: three
      // assets went in, two converted and one is declined. An asset in neither list is
      // the defect R65 fixed, and this fails the moment one reappears there.
      const plan = replacePlan();
      const declinedAssets = plan.declined
        .map((entry) => entry.path)
        .filter((path) => path.startsWith('public/'));

      expect(plan.conversions.map((conversion) => conversion.asset)).toEqual([
        'public/a-light.png',
        'public/a-mid.png',
      ]);
      expect(declinedAssets).toEqual(['public/a-dark.png']);
    });

    it('keeps the original of every target that converted, naming the reference that needs it', () => {
      // The actionable part now: WHERE the reference is and what it says, so a reader
      // who wants the originals gone knows which line to change.
      const plan = replacePlan();

      expect(plan.conversions.every((conversion) => !conversion.replacesOriginal)).toBe(true);
      expect(plan.keptOriginals.map((kept) => kept.asset)).toEqual([
        'public/a-light.png',
        'public/a-mid.png',
      ]);
      for (const kept of plan.keptOriginals) {
        expect(kept.reason).toContain('`src/App.jsx` reaches it through `./a-${mode}.png`');
        expect(kept.reason).toContain('assembled at runtime');
      }
    });

    it('does not report a blocker twice under two different explanations', () => {
      // `a-dark.png` failed for its own reason and already has an entry. Adding a
      // second one saying it was withdrawn would describe one failure as two.
      const entries = replacePlan().declined.filter((entry) => entry.path === 'public/a-dark.png');

      expect(entries).toHaveLength(1);
      expect(entries[0]?.reason).not.toContain('shares a pattern reference');
    });

    it('converts exactly what keep-original converts — the two policies now agree on a pattern', () => {
      // The originals survive under both, so the conversions stand and only the rewrite
      // is declined. A withdrawal under one policy and not the other was the tell that
      // the withdrawal rested on a deletion that R180 no longer makes.
      const keep = planOptimization(
        input({ assets: three, references: threeReferences, probes: threeProbes }),
      );

      expect(keep.conversions.map((conversion) => conversion.asset)).toEqual([
        'public/a-light.png',
        'public/a-mid.png',
      ]);
      expect(replacePlan().conversions.map((conversion) => conversion.asset)).toEqual(
        keep.conversions.map((conversion) => conversion.asset),
      );
    });

    it('decides the same on every run, whatever order the graph listed the targets in', () => {
      // Rule 11. Two blockers and one survivor, listed in both orders: a plan that
      // picked whichever the graph listed first would differ between runs over an
      // unchanged tree.
      // ⚠️ Its own assets, because `three` gives every asset 10 000 bytes by default
      // and a 4 000-byte encode is a saving — so probing `a-mid` at 4 000 converts it
      // and leaves one blocker again. Here `a-mid` and `a-dark` are both smaller than
      // their own encode, so both genuinely fail.
      const twoSmall = [
        asset('public/a-light.png'),
        asset('public/a-mid.png', 1_000),
        asset('public/a-dark.png', 1_000),
      ];
      const twoBlockers = [
        probe('public/a-light.png', 400),
        probe('public/a-mid.png', 4_000),
        probe('public/a-dark.png', 4_000),
      ];
      const reversed = [
        pattern('src/App.jsx', './a-${mode}.png', [
          'public/a-dark.png',
          'public/a-mid.png',
          'public/a-light.png',
        ]),
      ];

      const forwards = planOptimization(
        input({
          assets: twoSmall,
          references: threeReferences,
          probes: twoBlockers,
          publicPolicy: 'replace',
        }),
      );
      const backwards = planOptimization(
        input({
          assets: twoSmall,
          references: reversed,
          probes: twoBlockers,
          publicPolicy: 'replace',
        }),
      );

      // Stated as well as compared: an implementation that reversed both would satisfy
      // the equality without deciding anything stable.
      expect(forwards.keptOriginals.map((kept) => kept.asset)).toEqual(['public/a-light.png']);
      expect(backwards.keptOriginals).toEqual(forwards.keptOriginals);
      expect(reasonsByPath(backwards)).toEqual(reasonsByPath(forwards));
    });

    it('reports a kept original once when two patterns both name it, and counts the second', () => {
      // One asset, two references that need it: one entry naming the first and counting
      // the rest, as R77's reason does. Two entries for one asset would inflate every
      // count built from `keptOriginals`.
      const twoPatterns = [
        pattern('src/App.jsx', './a-${mode}.png', ['public/a-light.png', 'public/a-dark.png']),
        pattern('src/Other.jsx', './a-${theme}.png', ['public/a-light.png', 'public/a-dark.png']),
      ];
      const plan = planOptimization(
        input({
          assets: three,
          references: twoPatterns,
          probes: threeProbes,
          publicPolicy: 'replace',
        }),
      );
      const kept = plan.keptOriginals.filter((entry) => entry.asset === 'public/a-light.png');

      expect(kept).toHaveLength(1);
      expect(kept[0]?.reason).toContain(
        '`src/App.jsx` reaches it through `./a-${mode}.png` (and 1 more)',
      );
      expect(plan.declined.filter((entry) => entry.path === 'public/a-light.png')).toEqual([]);
    });
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

  describe('R66: keeping that original is correct, and saying so is the fix', () => {
    /**
     * 🔴 **The behaviour was right and the silence was not.** R66 measured `scratch-www`
     * (2026-09-13, before R180): 374 conversions produced **373** deletes, and the one
     * asset whose original survived said so nowhere — so a user who asked for `replace`
     * got one original back with nothing accounting for the difference. Fifth silent
     * omission of the phase, and the first where the behaviour under it needed no change
     * at all. ⚠️ A dated figure, not a current one: R181 re-measured it.
     *
     * Why it is right: inside a served directory a reference we failed to rewrite is a
     * **404** — bad, but visible. Outside one the asset is bundler-managed and the same
     * miss is a **build failure**. Different severity, different default.
     */
    const outside = {
      assets: [asset('src/logo.png')],
      references: [resolved('src/App.jsx', './logo.png', 'src/logo.png')],
      publicPolicy: 'replace' as const,
    };

    it('reports the kept original with a reason naming the consequence', () => {
      const plan = planOptimization(input(outside));

      expect(plan.keptOriginals).toEqual([
        { asset: 'src/logo.png', reason: expect.stringContaining('break the build') },
      ]);
      expect(plan.keptOriginals[0]?.reason).toContain('outside a directory this project serves');
    });

    it('keeps the asset OUT of declined, which says it was not converted', () => {
      // ⚠️ The property the whole design rests on. The report renders `declined` under
      // "Examined and not converted", so filing a converted asset there would put it
      // under a heading saying the opposite — two counts that cannot both be true,
      // which is R21 #4's shape. The lists are disjoint and `conversions` is complete.
      const plan = planOptimization(input(outside));

      expect(plan.conversions.map((conversion) => conversion.asset)).toEqual(['src/logo.png']);
      expect(plan.declined.map((entry) => entry.path)).not.toContain('src/logo.png');
    });

    it('says nothing under keep-original, where every original is kept', () => {
      // Reporting it there would be 374 copies of a sentence that means nothing,
      // which buries the one case that does. Same argument as `PlanRefusal`'s.
      expect(
        planOptimization(input({ ...outside, publicPolicy: 'keep-original' })).keptOriginals,
      ).toEqual([]);
    });

    it('says nothing about a public asset, whose original really is removed', () => {
      const plan = planOptimization(
        input({
          assets: [asset('public/hero.png')],
          references: [resolved('index.html', '/hero.png', 'public/hero.png')],
          publicPolicy: 'replace',
        }),
      );

      expect(plan.conversions[0]?.replacesOriginal).toBe(true);
      expect(plan.keptOriginals).toEqual([]);
    });

    it('does not claim a kept original for an asset that never converted', () => {
      // 🔴 Derived from the SURVIVING conversions, not collected as they were decided.
      // A collision withdraws both conversions after they were decided, so a list built
      // earlier would report a kept original for a file that was never written — a
      // false statement about a file on disk, which is worse than the silence it
      // replaced. (R65's pattern withdrawal was this test's trigger until R181 retired it.)
      const plan = planOptimization(
        input({
          assets: [asset('src/a.png'), asset('src/a.gif')],
          references: [
            resolved('src/App.jsx', './a.png', 'src/a.png'),
            resolved('src/Other.jsx', './a.gif', 'src/a.gif'),
          ],
          publicPolicy: 'replace',
        }),
      );

      expect(plan.conversions).toEqual([]);
      expect(plan.keptOriginals).toEqual([]);
    });
  });

  describe('🔴 R180: an original goes only when a reference links it and this plan rewrites every one', () => {
    /**
     * The property, not the case that exposed it. Under `replace`, four pieces that were
     * each right alone deleted every original behind a pattern whose targets all
     * converted — `/theme-${mode}.png` went on asking for `.png` — and the original of
     * every public asset nothing links to. Each member below goes red when its part of
     * `originalsStillNeeded` is removed. The first two are the positive controls: a fix
     * that simply switched `replace` off passes every other test here, and fails those.
     */
    const theme = [asset('public/theme-light.png'), asset('public/theme-dark.png')];
    const template = pattern('src/Theme.jsx', '/theme-${mode}.png', [
      'public/theme-light.png',
      'public/theme-dark.png',
    ]);

    function replacing(assets: Asset[], references: Reference[], over: Partial<PlanInput> = {}) {
      return planOptimization(input({ assets, references, publicPolicy: 'replace', ...over }));
    }

    it('deletes the original whose one reference is rewritten — the positive control', () => {
      const plan = replacing(
        [asset('public/logo.png')],
        [resolved('index.html', '/logo.png', 'public/logo.png')],
      );

      expect(plan.conversions[0]?.replacesOriginal).toBe(true);
      expect(plan.rewrites).toHaveLength(1);
      expect(plan.keptOriginals).toEqual([]);
    });

    it('deletes it when two references link it and both are rewritten', () => {
      const plan = replacing(
        [asset('public/logo.png')],
        [
          resolved('about.html', '/logo.png', 'public/logo.png'),
          resolved('index.html', '/logo.png', 'public/logo.png'),
        ],
      );

      expect(plan.conversions[0]?.replacesOriginal).toBe(true);
      expect(plan.rewrites.map((rewrite) => rewrite.file)).toEqual(['about.html', 'index.html']);
      expect(plan.keptOriginals).toEqual([]);
    });

    it('keeps every original behind a template whose targets ALL convert — the defect itself', () => {
      const plan = replacing(theme, [template]);

      expect(plan.conversions.map((c) => [c.asset, c.replacesOriginal])).toEqual([
        ['public/theme-dark.png', false],
        ['public/theme-light.png', false],
      ]);
      expect(plan.keptOriginals.map((kept) => kept.asset)).toEqual([
        'public/theme-dark.png',
        'public/theme-light.png',
      ]);
      for (const kept of plan.keptOriginals) {
        expect(kept.reason).toContain(
          '`src/Theme.jsx` reaches it through `/theme-${mode}.png`, a path assembled at runtime',
        );
      }
    });

    it('keeps them behind a + chain resolved as a pattern, as it does behind its template twin (R175)', () => {
      const chain = {
        ...pattern('src/theme.ts', "/theme-' + mode + '.png", [
          'public/theme-light.png',
          'public/theme-dark.png',
        ]),
        kind: 'string',
        shape: 'js.concat.pattern',
        asserted: false,
        assembledPath: '/theme-${}.png',
      } as Reference;
      const plan = replacing(theme, [chain]);

      expect(plan.conversions.map((c) => c.replacesOriginal)).toEqual([false, false]);
      expect(plan.keptOriginals).toHaveLength(2);
      expect(plan.keptOriginals[0]?.reason).toContain(
        "reaches it through `/theme-' + mode + '.png`",
      );
    });

    it('keeps it when a literal naming it IS rewritten but a pattern still needs it', () => {
      const plan = replacing(theme, [
        resolved('index.html', '/theme-light.png', 'public/theme-light.png'),
        template,
      ]);
      const light = plan.conversions.find((c) => c.asset === 'public/theme-light.png');

      // The literal moves — that edit is still worth making — and the original stays.
      expect(plan.rewrites.map((rewrite) => rewrite.file)).toEqual(['index.html']);
      expect(light?.replacesOriginal).toBe(false);
    });

    it('keeps it when the literal naming it is refused, without R77 having to find the text', () => {
      // Member (b), made DIRECT. The rewrite is refused — a root-relative path that
      // missed the declared root — and until R180 only R77's text search stood between
      // this and a deleted original. That search looks for the path as written, and
      // `h%65ro.png` holds none of its spellings. `blockedByMention` is deliberately
      // absent: the planner alone has to decide.
      const plan = replacing(
        [asset('public/hero.png')],
        [
          resolved('index.html', '/public/h%65ro.png', 'public/hero.png', {
            resolvedVia: 'project-root',
          }),
        ],
        { servingRoots: { dirs: ['public'], declared: true } },
      );

      expect(plan.rewrites).toEqual([]);
      expect(plan.conversions[0]?.replacesOriginal).toBe(false);
      expect(plan.keptOriginals[0]?.reason).toContain(
        '`index.html` names it as `/public/h%65ro.png`, and this run does not rewrite that reference',
      );
    });

    it('keeps it when a rewrite would change nothing, because nothing moved', () => {
      // `./logo` has no extension to swap, so no edit is recorded. "Rewritten" means an
      // edit this plan holds — not a reference it looked at.
      const plan = replacing(
        [asset('public/logo.png')],
        [resolved('src/App.jsx', './logo', 'public/logo.png')],
      );

      expect(plan.rewrites).toEqual([]);
      expect(plan.conversions[0]?.replacesOriginal).toBe(false);
    });

    it('gives R66 its own reason beside R180, each asset under the one that applies', () => {
      const plan = replacing(
        [asset('src/logo.png'), ...theme],
        [resolved('src/App.jsx', './logo.png', 'src/logo.png'), template],
      );

      expect(Object.fromEntries(plan.keptOriginals.map((k) => [k.asset, k.reason]))).toEqual({
        'public/theme-dark.png': expect.stringContaining('assembled at runtime'),
        'public/theme-light.png': expect.stringContaining('assembled at runtime'),
        'src/logo.png': expect.stringContaining('outside a directory this project serves'),
      });
    });
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

describe('an asset that was measured and gained nothing', () => {
  it('is declined with a reason rather than dropped in silence', () => {
    // B2's unease (f), confirmed on the astro fixture: all seven of its assets encode
    // larger as webp, the planner declined all seven, and nothing in the report
    // mentioned any of them. A format-opportunity finding only exists when there is an
    // opportunity, and the audit's skip list only holds measurements never taken, so
    // this case was reported nowhere at all. A silent skip is a P0 (rule 9).
    const plan = planOptimization(
      input({
        assets: [asset('src/logo.png', 70)],
        references: [resolved('src/App.jsx', './logo.png', 'src/logo.png')],
        probes: [probe('src/logo.png', 94)],
      }),
    );

    expect(plan.conversions).toEqual([]);
    expect(plan.declined).toEqual([
      {
        path: 'src/logo.png',
        line: null,
        reason:
          'measured as webp and came out no smaller, so converting it would cost bytes rather than save them',
      },
    ]);
  });

  it('stays silent about an asset nothing measured, which the audit does report', () => {
    // The other half of what a null reason used to mean at once. A probe skip names
    // the cap, the vector or the format, and it reaches the report on its own; saying
    // it twice would bury the real decisions under every file in the repository.
    const plan = planOptimization(
      input({
        assets: [asset('src/logo.png', 70)],
        references: [resolved('src/App.jsx', './logo.png', 'src/logo.png')],
        probes: [],
      }),
    );

    expect(plan.conversions).toEqual([]);
    expect(plan.declined).toEqual([]);
  });
});

describe('two assets that would convert to one name', () => {
  // The case that made optimize --apply unusable on three of five real repositories.
  // Swapping the extension is not injective, so a repository holding both distance.png
  // and distance.gif produces a plan with two creates at distance.webp.
  const assets = [asset('static/distance.gif'), asset('static/distance.png')];
  const references = [
    resolved('index.html', 'static/distance.gif', 'static/distance.gif'),
    resolved('index.html', 'static/distance.png', 'static/distance.png'),
  ];

  it('converts neither, and tells each one which file it collided with', () => {
    const plan = planOptimization(input({ assets, references, publicDir: 'static' }));

    expect(plan.conversions).toEqual([]);
    expect(plan.declined).toEqual([
      {
        path: 'static/distance.gif',
        line: null,
        reason:
          'static/distance.png would also convert to static/distance.webp, so converting it would replace a file rather than add one. Rename one of them and run again.',
      },
      {
        path: 'static/distance.png',
        line: null,
        reason:
          'static/distance.gif would also convert to static/distance.webp, so converting it would replace a file rather than add one. Rename one of them and run again.',
      },
    ]);
  });

  it('leaves the references to both of them exactly as they were', () => {
    const plan = planOptimization(input({ assets, references, publicDir: 'static' }));

    expect(plan.rewrites).toEqual([]);
  });

  it('names all the others when three collide, in a fixed order', () => {
    const three = [asset('img/a.gif'), asset('img/a.jpeg'), asset('img/a.png')];
    const plan = planOptimization(
      input({
        assets: three,
        references: three.map((a) => resolved('index.html', a.relative, a.relative)),
        publicDir: 'img',
      }),
    );

    expect(plan.conversions).toEqual([]);
    expect(plan.declined.map((d) => d.reason)).toEqual([
      expect.stringContaining('img/a.jpeg and img/a.png would also convert to img/a.webp'),
      expect.stringContaining('img/a.gif and img/a.png would also convert to img/a.webp'),
      expect.stringContaining('img/a.gif and img/a.jpeg would also convert to img/a.webp'),
    ]);
  });

  // The near miss, and the reason the count of colliding basenames in a repository is
  // not the count of conversions this costs. Sharing a basename is not a collision
  // when only one of the two was ever going to be written: nothing is overwritten, the
  // other file stays where it is, and every reference to it keeps resolving.
  it('still converts the one that converts when the other was never going to', () => {
    const plan = planOptimization(
      input({
        assets,
        references,
        publicDir: 'static',
        probes: [probe('static/distance.gif', 40_000), probe('static/distance.png', 4_000)],
      }),
    );

    expect(plan.conversions.map((c) => c.asset)).toEqual(['static/distance.png']);
    expect(plan.declined.map((d) => d.reason)).not.toContainEqual(
      expect.stringContaining('would also convert'),
    );
  });

  it('withdraws the rewrite of a template that matches a collided asset', () => {
    const three = [
      asset('public/a-light.png'),
      asset('public/a-light.gif'),
      asset('public/a-dark.png'),
    ];
    const plan = planOptimization(
      input({
        assets: three,
        references: [
          pattern('src/App.jsx', './a-${mode}.png', ['public/a-light.png', 'public/a-dark.png']),
        ],
      }),
    );

    // a-light collided with a-light.gif and was withdrawn, so the pattern no longer
    // has every target converting and its single edit would break the reference for
    // both. Rewriting it here is what would happen if the collision were detected
    // after the pattern veto rather than before it.
    expect(plan.conversions.map((c) => c.asset)).toEqual(['public/a-dark.png']);
    expect(plan.rewrites).toEqual([]);
  });
});

describe('an asset whose converted name is already taken', () => {
  // Never reached on the corpus, because the repositories that have it abort on the
  // mutual collision first. prepare would refuse the create, which aborts the whole
  // run rather than declining the one asset.
  const assets = [asset('img/possum.png'), asset('img/possum.webp')];
  const references = [resolved('index.html', 'img/possum.png', 'img/possum.png')];

  it('declines rather than writing over the file that is there', () => {
    const plan = planOptimization(input({ assets, references, publicDir: 'img' }));

    expect(plan.conversions).toEqual([]);
    expect(plan.declined).toEqual([
      {
        path: 'img/possum.png',
        line: null,
        reason:
          'img/possum.webp already exists, so converting it would replace a file rather than add one. Rename one of them and run again.',
      },
    ]);
  });

  it('reports both obstacles when a colliding pair also lands on an existing file', () => {
    const plan = planOptimization(
      input({
        assets: [asset('img/possum.jpg'), asset('img/possum.png'), asset('img/possum.webp')],
        references: [
          resolved('index.html', 'img/possum.jpg', 'img/possum.jpg'),
          resolved('index.html', 'img/possum.png', 'img/possum.png'),
        ],
        publicDir: 'img',
      }),
    );

    // Renaming one of the pair leaves the other still blocked by the file that is
    // already there, so a reason naming only the pair would send somebody round twice.
    expect(plan.declined.map((d) => d.reason)).toEqual([
      'img/possum.png would also convert to img/possum.webp, and img/possum.webp already exists, so converting it would replace a file rather than add one. Rename one of them and run again.',
      'img/possum.jpg would also convert to img/possum.webp, and img/possum.webp already exists, so converting it would replace a file rather than add one. Rename one of them and run again.',
    ]);
  });
});

describe('two assets whose converted names differ only in case', () => {
  // Found by asking what the exact-string comparison above cannot see. railsgirls-com
  // carries four of these: Reaktor.jpg and reaktor.png produce Reaktor.webp and
  // reaktor.webp, which are two files on Linux and one file on Windows and macOS.
  // Nothing caught it. prepare claims paths by exact string and both creates pass its
  // absent check, because at that point neither file exists yet, so commit wrote one
  // image over the other and repointed a reference at whichever landed second.
  const assets = [asset('images/Reaktor.jpg'), asset('images/reaktor.png')];
  const references = [
    resolved('index.html', 'images/Reaktor.jpg', 'images/Reaktor.jpg'),
    resolved('index.html', 'images/reaktor.png', 'images/reaktor.png'),
  ];

  it('declines both rather than silently writing one image over the other', () => {
    const plan = planOptimization(input({ assets, references, publicDir: 'images' }));

    expect(plan.conversions).toEqual([]);
    expect(plan.rewrites).toEqual([]);
  });

  it('says why two different names are one file, so the report does not look broken', () => {
    const plan = planOptimization(input({ assets, references, publicDir: 'images' }));

    expect(plan.declined.map((d) => d.reason)).toEqual([
      'images/reaktor.png would convert to images/reaktor.webp, which is the same file as images/Reaktor.webp on Windows and macOS, so converting it would replace a file rather than add one. Rename one of them and run again.',
      'images/Reaktor.jpg would convert to images/Reaktor.webp, which is the same file as images/reaktor.webp on Windows and macOS, so converting it would replace a file rather than add one. Rename one of them and run again.',
    ]);
  });

  it('declines when the existing file differs from the target only in case', () => {
    const plan = planOptimization(
      input({
        assets: [asset('img/Logo.png'), asset('img/logo.webp')],
        references: [resolved('index.html', 'img/Logo.png', 'img/Logo.png')],
        publicDir: 'img',
      }),
    );

    expect(plan.conversions).toEqual([]);
    expect(plan.declined[0]?.reason).toContain(
      'img/logo.webp already exists, and is the same file as img/Logo.webp on Windows and macOS',
    );
  });
});

describe('a project that serves from its own project root', () => {
  // The same empty-string defect the audit had, in different code, reached a different
  // way. Appending a slash to '' gives '/', and a project-relative path never begins
  // with one, so every asset on a root-served site scored as not public. Here that
  // decides whether an unlinked asset is worth converting and whether an original may
  // be removed, rather than which findings carry an outside-link warning.
  const assets = [asset('images/orphan.png'), asset('images/hero.png')];
  const references = [resolved('index.html', '/images/hero.png', 'images/hero.png')];

  it('converts an unlinked asset, because outside the repository may still load it', () => {
    const plan = planOptimization(input({ assets, references, publicDir: '' }));

    // With '' misread as "nothing is public", orphan.png declined for having no
    // references. On a site that uploads its own repository that is wrong: nothing
    // in the reference graph can show a file is unreachable from outside.
    expect(plan.conversions.map((c) => c.asset)).toEqual(['images/hero.png', 'images/orphan.png']);
  });

  it('removes the original under replace, because the whole tree is the public dir', () => {
    const plan = planOptimization(
      input({ assets, references, publicDir: '', publicPolicy: 'replace' }),
    );

    // ⚠️ Until R180 this asserted EVERY original went — `orphan.png`'s included, the
    // vacuous case, whose original nothing had moved away from. `hero.png` is what shows
    // `''` is read as public: a linked asset whose reference is rewritten loses it.
    expect(plan.conversions.map((c) => [c.asset, c.replacesOriginal])).toEqual([
      ['images/hero.png', true],
      ['images/orphan.png', false],
    ]);
  });

  it('still treats null as serving nothing publicly, which is the opposite', () => {
    const plan = planOptimization(input({ assets, references, publicDir: null }));

    // An unlinked asset outside any public directory gains only bytes, so it is
    // declined. The empty string and the absent directory must not collapse together.
    expect(plan.conversions.map((c) => c.asset)).toEqual(['images/hero.png']);
    expect(plan.declined.map((d) => d.path)).toContain('images/orphan.png');
  });
});
