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

function input(
  over: Partial<PlanInput> & {
    assets: Asset[];
    references: Reference[];
    /** Shorthand for undeclared serving roots. */
    served?: readonly string[];
  },
): PlanInput {
  return {
    graph: buildGraph({
      root: ROOT,
      assets: over.assets,
      references: over.references,
      unscannedFiles: [],
    }),
    probes: over.probes ?? over.assets.map((a) => probe(a.relative)),
    format: 'webp',
    publicPolicy: over.publicPolicy ?? 'keep-original',
    hedged: over.hedged ?? new Set(),
    servingRoots: over.servingRoots ?? { dirs: over.served ?? ['public'], declared: false },
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

  it('is not converted under replace, because the new file would be used by nobody', () => {
    // Under `replace` the original has to stay, since nothing moved away from it, and no
    // reference would ask for the new file: converting would leave exactly the pair of
    // files `replace` exists to avoid. Hedged or not: something unreadable still names
    // the original, not the new file.
    const plan = planOptimization(
      input({
        assets: [asset('public/hero.png'), asset('public/maybe.png')],
        references: [],
        hedged: new Set(['public/maybe.png']),
        publicPolicy: 'replace',
      }),
    );

    expect(plan.conversions).toEqual([]);
    expect(plan.keptOriginals).toEqual([]);
    expect(reasonsByPath(plan)).toEqual({
      'public/hero.png': expect.stringContaining(
        'nothing Upfly can see links to it, so a new file would be used by nobody',
      ),
      'public/maybe.png': expect.stringContaining(
        'something it could not read mentions it by its current name',
      ),
    });
    // What would unblock it, so the sentence is something a reader can act on.
    expect(reasonsByPath(plan)['public/hero.png']).toContain(
      'without `--replace` it can be converted',
    );
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

    // The end is derived from the path being replaced rather than written down:
    // `/hero.png` is nine characters, not the ten of `./logo.png` above.
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

  it('converts none of them under replace, because no reference would move to a new file', () => {
    // The template still asks for `.png` whatever converts, so a converted copy would sit
    // beside an original that has to stay.
    const plan = planOptimization(input({ assets, references, probes, publicPolicy: 'replace' }));

    expect(plan.conversions).toEqual([]);
    expect(plan.keptOriginals).toEqual([]);
    expect(reasonsByPath(plan)['public/a-light.png']).toContain(
      '`src/App.jsx` reaches it only through `./a-${mode}.png`, a path assembled at runtime',
    );
  });

  it('says the reference stayed once, and truthfully, when only some targets convert', () => {
    // One decline for the reference: "1 of them do not convert", and not also "assembled
    // at runtime ... even though every asset it matches converted", which is false when
    // one did not. Under `replace` neither target converts, and the one sentence counts
    // both.
    const expected = {
      'keep-original': 'matches 2 assets and 1 of them',
      replace: 'matches 2 assets and 2 of them',
    } as const;
    for (const publicPolicy of ['keep-original', 'replace'] as const) {
      const plan = planOptimization(input({ assets, references, probes, publicPolicy }));
      const reasons = plan.declined
        .filter((entry) => entry.path === 'src/App.jsx')
        .map((entry) => entry.reason);

      expect(reasons).toEqual([expect.stringContaining(expected[publicPolicy])]);
    }
  });

  describe('a partial pattern under replace, where a target only the pattern reaches is not converted', () => {
    /**
     * Under `replace` a target only the pattern reaches is declined: the pattern still
     * asks for the original, so no reference would ever ask for a converted copy.
     *
     * Asserted here: every asset the pattern matched is accounted for, nothing is
     * reported twice, and the plan is the same on every run.
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
      // The whole claim, stated as arithmetic rather than as a spot check: three assets
      // went in and all three are declined, one for its own reason and two because only
      // the pattern reaches them. An asset in neither list would be a silent skip, and
      // this fails the moment one appears.
      const plan = replacePlan();
      const declinedAssets = plan.declined
        .map((entry) => entry.path)
        .filter((path) => path.startsWith('public/'));

      expect(plan.conversions).toEqual([]);
      expect(declinedAssets).toEqual([
        'public/a-dark.png',
        'public/a-light.png',
        'public/a-mid.png',
      ]);
    });

    it('declines every target only the pattern reaches, naming the reference that holds it', () => {
      // The actionable part: where the reference is and what it says, so a reader who
      // wants these converted under `replace` knows which line would have to change.
      const plan = replacePlan();
      const reasons = reasonsByPath(plan);

      expect(plan.keptOriginals).toEqual([]);
      for (const path of ['public/a-light.png', 'public/a-mid.png']) {
        expect(reasons[path]).toContain('`src/App.jsx` reaches it only through `./a-${mode}.png`');
        expect(reasons[path]).toContain('used by nobody');
      }
    });

    it('does not report a blocker twice under two different explanations', () => {
      // `a-dark.png` failed for its own reason and already has an entry. Adding a
      // second one saying it was withdrawn would describe one failure as two.
      const entries = replacePlan().declined.filter((entry) => entry.path === 'public/a-dark.png');

      expect(entries).toHaveLength(1);
      expect(entries[0]?.reason).not.toContain('shares a pattern reference');
    });

    it('still converts them under keep-original, whose users asked for both files', () => {
      // The scope of the rule. Under `keep-original` two files are the point, so the
      // targets that convert stand and only the rewrite is declined.
      const keep = planOptimization(
        input({ assets: three, references: threeReferences, probes: threeProbes }),
      );

      expect(keep.conversions.map((conversion) => conversion.asset)).toEqual([
        'public/a-light.png',
        'public/a-mid.png',
      ]);
      expect(replacePlan().conversions).toEqual([]);
    });

    it('decides the same on every run, whatever order the graph listed the targets in', () => {
      // The same input must give the same plan. Two blockers and one survivor, listed in
      // both orders: a plan that picked whichever the graph listed first would differ
      // between runs over an unchanged tree.
      // Its own assets, because `three` gives every asset 10 000 bytes by default and a
      // 4 000-byte encode is a saving, which would convert `a-mid` and leave one blocker.
      // Here `a-mid` and `a-dark` are both smaller than their own encode, so both fail.
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
      expect(reasonsByPath(forwards)['public/a-light.png']).toContain('reaches it only through');
      expect(backwards.conversions).toEqual(forwards.conversions);
      expect(reasonsByPath(backwards)).toEqual(reasonsByPath(forwards));
    });

    it('declines an asset once when two patterns both hold it, and counts the second', () => {
      // One asset, two references holding it: one entry naming the first and counting
      // the rest, as the kept-original sentences do. Two entries for one asset would
      // inflate every count built from `declined`.
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
      const entries = plan.declined.filter((entry) => entry.path === 'public/a-light.png');

      expect(entries).toHaveLength(1);
      expect(entries[0]?.reason).toContain(
        '`src/App.jsx` reaches it only through `./a-${mode}.png` (and 1 more)',
      );
      expect(plan.keptOriginals).toEqual([]);
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

  describe('reporting the original kept outside the public directory', () => {
    /**
     * Inside a served directory, a reference the run failed to rewrite is a missing image:
     * bad, but visible. Outside one the asset is bundler-managed, and the same miss breaks
     * the build. So the original stays, and a user who asked for `replace` is told why.
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
      // The report renders `declined` under "Examined and not converted", so filing a
      // converted asset there would put it under a heading saying the opposite, and two
      // of the report's counts could not both be true. The lists are disjoint and
      // `conversions` is complete.
      const plan = planOptimization(input(outside));

      expect(plan.conversions.map((conversion) => conversion.asset)).toEqual(['src/logo.png']);
      expect(plan.declined.map((entry) => entry.path)).not.toContain('src/logo.png');
    });

    it('says nothing under keep-original, where every original is kept', () => {
      // Reporting it there would repeat a sentence that means nothing once per
      // conversion, burying the case that does. The same argument as `PlanRefusal`'s.
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
      // Kept originals are derived from the surviving conversions, not collected as they
      // were decided. A collision withdraws both conversions after they were decided, so
      // a list built earlier would report a kept original for a file that was never
      // written: a false statement about a file on disk.
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

  describe('under replace: an asset converts only if a reference moves to it, and its original goes only if all do', () => {
    /**
     * Both halves of one property, stated for every kind of reference that does not move:
     * a pattern, a refused literal, a path with no extension to change. Without the
     * deletion half, the originals behind `/theme-${mode}.png` would go while it still
     * asks for `.png`; without the conversion half, their converted copies would sit
     * beside them used by nothing.
     *
     * So each member appears twice. Alone, nothing moves to its asset, and the asset is
     * not converted. Beside a literal that does move, the asset converts and the member
     * keeps its original. The first two tests are the positive controls: a fix that
     * switched `replace` off passes every other test here, and fails those.
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

    it('converts nothing a template alone reaches, so it deletes nothing and writes no unused copy', () => {
      const plan = replacing(theme, [template]);

      expect(plan.conversions).toEqual([]);
      expect(plan.keptOriginals).toEqual([]);
      for (const path of ['public/theme-dark.png', 'public/theme-light.png']) {
        expect(reasonsByPath(plan)[path]).toContain(
          '`src/Theme.jsx` reaches it only through `/theme-${mode}.png`, a path assembled at runtime that no run can rewrite',
        );
      }
    });

    it('converts nothing a + chain alone reaches, as for its template twin', () => {
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

      expect(plan.conversions).toEqual([]);
      expect(reasonsByPath(plan)['public/theme-light.png']).toContain(
        "reaches it only through `/theme-' + mode + '.png`",
      );
    });

    it('keeps it when a literal naming it IS rewritten but a pattern still needs it', () => {
      const plan = replacing(theme, [
        resolved('index.html', '/theme-light.png', 'public/theme-light.png'),
        template,
      ]);
      const light = plan.conversions.find((c) => c.asset === 'public/theme-light.png');

      // The literal moves, which is what makes the new file worth writing, and the
      // original stays for the template. `theme-dark` has only the template, so it is
      // not converted at all.
      expect(plan.rewrites.map((rewrite) => rewrite.file)).toEqual(['index.html']);
      expect(light?.replacesOriginal).toBe(false);
      expect(plan.keptOriginals.map((kept) => kept.asset)).toEqual(['public/theme-light.png']);
      expect(plan.keptOriginals[0]?.reason).toContain(
        '`src/Theme.jsx` reaches it through `/theme-${mode}.png`, a path assembled at runtime',
      );
      expect(plan.conversions.map((c) => c.asset)).toEqual(['public/theme-light.png']);
    });

    /** A root-relative path that missed the declared root, so its rewrite is refused. */
    const refused = resolved('index.html', '/public/h%65ro.png', 'public/hero.png', {
      resolvedVia: 'project-root',
    });
    const declared = { servingRoots: { dirs: ['public'], declared: true } };

    it('declines it when the only literal naming it is refused, saying why that literal stays', () => {
      const plan = replacing([asset('public/hero.png')], [refused], declared);

      expect(plan.conversions).toEqual([]);
      expect(reasonsByPath(plan)['public/hero.png']).toContain(
        '`index.html` names it as `/public/h%65ro.png`, and this run does not rewrite that reference: the path is root-relative and missed the configured serving root',
      );
    });

    it('keeps it when a refused literal still needs it beside one that moves, without the text search finding it', () => {
      // The old-path text search looks for the path as written, and `h%65ro.png` holds
      // none of its spellings, so the planner has to keep this original by itself.
      // `blockedByMention` is absent here, so the planner alone decides.
      const plan = replacing(
        [asset('public/hero.png')],
        [resolved('about.html', '/hero.png', 'public/hero.png'), refused],
        declared,
      );

      expect(plan.rewrites.map((rewrite) => rewrite.file)).toEqual(['about.html']);
      expect(plan.conversions[0]?.replacesOriginal).toBe(false);
      expect(plan.keptOriginals[0]?.reason).toContain(
        '`index.html` names it as `/public/h%65ro.png`, and this run does not rewrite that reference',
      );
    });

    /** `./logo` has no extension to swap, so no edit is recorded for it. */
    const unchanged = resolved('src/App.jsx', './logo', 'public/logo.png');

    it('declines it when the only reference has no extension to change', () => {
      // "Moves" means an edit this plan holds, not a reference it looked at.
      const plan = replacing([asset('public/logo.png')], [unchanged]);

      expect(plan.conversions).toEqual([]);
      expect(reasonsByPath(plan)['public/logo.png']).toContain(
        '`src/App.jsx` names it as `./logo`, which has no extension to change',
      );
    });

    it('keeps it when a reference with no extension to change sits beside one that moves', () => {
      const plan = replacing(
        [asset('public/logo.png')],
        [resolved('index.html', '/logo.png', 'public/logo.png'), unchanged],
      );

      expect(plan.rewrites.map((rewrite) => rewrite.file)).toEqual(['index.html']);
      expect(plan.conversions[0]?.replacesOriginal).toBe(false);
      expect(plan.keptOriginals[0]?.reason).toContain('`src/App.jsx` names it as `./logo`');
    });

    it('converts an asset when any one of its references moves, not only when all of them do', () => {
      // The conversion half asks for one moving reference, the deletion half for all of
      // them. Requiring all of them to convert would decline both assets here, though each
      // has a literal moving to its new file and a template still asking for its original.
      const plan = replacing(theme, [
        template,
        resolved('about.html', '/theme-dark.png', 'public/theme-dark.png'),
        resolved('index.html', '/theme-light.png', 'public/theme-light.png'),
      ]);

      expect(plan.conversions.map((c) => [c.asset, c.replacesOriginal])).toEqual([
        ['public/theme-dark.png', false],
        ['public/theme-light.png', false],
      ]);
    });

    it('gives the outside-a-served-directory reason its own entry, beside the pattern one', () => {
      const plan = replacing(
        [asset('src/logo.png'), ...theme],
        [
          resolved('src/App.jsx', './logo.png', 'src/logo.png'),
          resolved('index.html', '/theme-light.png', 'public/theme-light.png'),
          template,
        ],
      );

      expect(Object.fromEntries(plan.keptOriginals.map((k) => [k.asset, k.reason]))).toEqual({
        'public/theme-light.png': expect.stringContaining('assembled at runtime'),
        'src/logo.png': expect.stringContaining('outside a directory this project serves'),
      });
    });

    it('declines an asset outside a served directory that only a pattern reaches, rather than keep a copy nobody uses', () => {
      // Outside a served directory `replace` never deletes, but no reference would move to
      // the new file there either. Converting would leave the same unused pair, reported
      // under a misleading reason: kept for the build's sake.
      const icons = [asset('src/icons/a.png'), asset('src/icons/b.png')];
      const byPattern = pattern('src/Icon.jsx', './icons/${name}.png', [
        'src/icons/a.png',
        'src/icons/b.png',
      ]);

      const plan = replacing(icons, [byPattern]);
      const keep = planOptimization(input({ assets: icons, references: [byPattern] }));

      expect(plan.conversions).toEqual([]);
      expect(plan.keptOriginals).toEqual([]);
      expect(reasonsByPath(plan)['src/icons/a.png']).toContain('reaches it only through');
      expect(keep.conversions.map((c) => c.asset)).toEqual(['src/icons/a.png', 'src/icons/b.png']);
    });

    it('leaves keep-original exactly as it was for every member', () => {
      // The rule's scope. The same project under `keep-original` converts the lot: its
      // users chose two files, and nothing here is about them.
      const everyMember = {
        assets: [
          asset('public/orphan.png'),
          asset('public/hero.png'),
          asset('public/logo.png'),
          ...theme,
        ],
        references: [refused, unchanged, template],
        ...declared,
      };

      const keep = planOptimization(input(everyMember));
      const replace = planOptimization(input({ ...everyMember, publicPolicy: 'replace' }));

      expect(keep.conversions.map((c) => c.asset)).toEqual([
        'public/hero.png',
        'public/logo.png',
        'public/orphan.png',
        'public/theme-dark.png',
        'public/theme-light.png',
      ]);
      expect(replace.conversions).toEqual([]);
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
    // A thrown error leaves a user with nothing; a returned refusal is a finding with a
    // reason, which reaches the report like every other declined item.
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
    // Nothing else reports this case: a format-opportunity finding exists only when there
    // is an opportunity, and the audit's skip list holds only measurements never taken.
    // Without a reason here the asset would be skipped silently.
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
    // An asset nothing measured has a probe skip naming the cap, the vector or the
    // format, which reaches the report on its own; saying it twice would bury the real
    // decisions under every file in the repository.
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
  // Swapping the extension is not injective, so a repository holding both distance.png
  // and distance.gif would produce a plan with two creates at distance.webp.
  const assets = [asset('static/distance.gif'), asset('static/distance.png')];
  const references = [
    resolved('index.html', 'static/distance.gif', 'static/distance.gif'),
    resolved('index.html', 'static/distance.png', 'static/distance.png'),
  ];

  it('converts neither, and tells each one which file it collided with', () => {
    const plan = planOptimization(input({ assets, references, served: ['static'] }));

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
    const plan = planOptimization(input({ assets, references, served: ['static'] }));

    expect(plan.rewrites).toEqual([]);
  });

  it('names all the others when three collide, in a fixed order', () => {
    const three = [asset('img/a.gif'), asset('img/a.jpeg'), asset('img/a.png')];
    const plan = planOptimization(
      input({
        assets: three,
        references: three.map((a) => resolved('index.html', a.relative, a.relative)),
        served: ['img'],
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
        served: ['static'],
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
  // Left to prepare, the create would be refused, which aborts the whole run rather than
  // declining the one asset.
  const assets = [asset('img/possum.png'), asset('img/possum.webp')];
  const references = [resolved('index.html', 'img/possum.png', 'img/possum.png')];

  it('declines rather than writing over the file that is there', () => {
    const plan = planOptimization(input({ assets, references, served: ['img'] }));

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
        served: ['img'],
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
  // What an exact-string comparison cannot see. Reaktor.jpg and reaktor.png produce
  // Reaktor.webp and reaktor.webp, which are two files on Linux and one file on Windows
  // and macOS. Neither exists yet, so both pass an absent check, and one image would be
  // written over the other. The planner declines the pair; `prepare` folds case too, but
  // a refusal there aborts the whole run.
  const assets = [asset('images/Reaktor.jpg'), asset('images/reaktor.png')];
  const references = [
    resolved('index.html', 'images/Reaktor.jpg', 'images/Reaktor.jpg'),
    resolved('index.html', 'images/reaktor.png', 'images/reaktor.png'),
  ];

  it('declines both rather than silently writing one image over the other', () => {
    const plan = planOptimization(input({ assets, references, served: ['images'] }));

    expect(plan.conversions).toEqual([]);
    expect(plan.rewrites).toEqual([]);
  });

  it('says why two different names are one file, so the report does not look broken', () => {
    const plan = planOptimization(input({ assets, references, served: ['images'] }));

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
        served: ['img'],
      }),
    );

    expect(plan.conversions).toEqual([]);
    expect(plan.declined[0]?.reason).toContain(
      'img/logo.webp already exists, and is the same file as img/Logo.webp on Windows and macOS',
    );
  });
});

describe('a project that serves from its own project root', () => {
  // A serving directory of '' is the project root. Appending a slash to '' gives '/',
  // which no project-relative path begins with, so a prefix test built that way would
  // score every asset on a root-served site as not public. Here that decides whether an
  // unlinked asset is worth converting and whether an original may be removed.
  const assets = [asset('images/orphan.png'), asset('images/hero.png')];
  const references = [resolved('index.html', '/images/hero.png', 'images/hero.png')];

  it('converts an unlinked asset, because outside the repository may still load it', () => {
    const plan = planOptimization(input({ assets, references, served: [''] }));

    // With '' misread as "nothing is public", orphan.png would be declined for having no
    // references. On a site that uploads its own repository that is wrong: nothing in
    // the reference graph can show a file is unreachable from outside.
    expect(plan.conversions.map((c) => c.asset)).toEqual(['images/hero.png', 'images/orphan.png']);
  });

  it('removes the original under replace, because the whole tree is the public dir', () => {
    const plan = planOptimization(
      input({ assets, references, served: [''], publicPolicy: 'replace' }),
    );

    // `hero.png` is what shows `''` is read as public: a linked asset whose reference is
    // rewritten loses its original. `orphan.png` is not converted, because nothing would
    // use its new file.
    expect(plan.conversions.map((c) => [c.asset, c.replacesOriginal])).toEqual([
      ['images/hero.png', true],
    ]);
    expect(reasonsByPath(plan)['images/orphan.png']).toContain('nothing Upfly can see links to it');
  });

  it('treats a project that declares no served directory as serving nothing, the opposite', () => {
    const plan = planOptimization(
      input({ assets, references, servingRoots: { dirs: [], declared: true } }),
    );

    // An unlinked asset outside any public directory gains only bytes, so it is
    // declined. The empty string and the absent directory must not collapse together.
    expect(plan.conversions.map((c) => c.asset)).toEqual(['images/hero.png']);
    expect(reasonsByPath(plan)['images/orphan.png']).toBe(
      'nothing links to it, so converting it would rewrite no reference and gain only bytes',
    );
  });
});

describe('which assets are served, when the run decided several roots or none', () => {
  const roots = { dirs: ['apps/a/public', 'apps/b/public'], declared: false };
  const twoRoots = [asset('apps/a/public/a.png'), asset('apps/b/public/b.png')];
  const twoReferences = [
    resolved('apps/a/index.html', '/a.png', 'apps/a/public/a.png'),
    resolved('apps/b/index.html', '/b.png', 'apps/b/public/b.png'),
  ];

  it('removes the original of an image in the second root once its references move', () => {
    const plan = planOptimization(
      input({
        assets: twoRoots,
        references: twoReferences,
        servingRoots: roots,
        publicPolicy: 'replace',
      }),
    );

    expect(plan.conversions.map((c) => [c.asset, c.replacesOriginal])).toEqual([
      ['apps/a/public/a.png', true],
      ['apps/b/public/b.png', true],
    ]);
    expect(plan.rewrites.map((r) => r.file)).toEqual(['apps/a/index.html', 'apps/b/index.html']);
    expect(plan.keptOriginals).toEqual([]);
  });

  it('converts an unlinked image in the second root, as it would in the first', () => {
    const plan = planOptimization(
      input({
        assets: [...twoRoots, asset('apps/b/public/unlinked.png')],
        references: twoReferences,
        servingRoots: roots,
      }),
    );

    expect(plan.conversions.map((c) => c.asset)).toContain('apps/b/public/unlinked.png');
  });

  it('finds no served image when no root was found, and says how to name one', () => {
    const plan = planOptimization(
      input({
        assets: [asset('images/hero.png'), asset('images/orphan.png')],
        references: [resolved('index.html', 'images/hero.png', 'images/hero.png')],
        servingRoots: { dirs: [], declared: false },
        publicPolicy: 'replace',
      }),
    );

    expect(plan.conversions.map((c) => [c.asset, c.replacesOriginal])).toEqual([
      ['images/hero.png', false],
    ]);
    expect(plan.keptOriginals).toEqual([
      {
        asset: 'images/hero.png',
        reason:
          'converted, but the original was kept: no website folder was found in this project, so Upfly cannot tell which images a browser loads by URL, and `--replace` removes an original only inside one. Name the folder the site is served from with `--public <dir>` or `publicDirs` in the config file, using "." for the project root itself, as on a plain HTML site.',
      },
    ]);
    expect(reasonsByPath(plan)['images/orphan.png']).toBe(
      'nothing links to it, and no website folder was found in this project, so Upfly cannot tell which images a browser loads by URL; converting it would gain only bytes. Name the folder the site is served from with `--public <dir>` or `publicDirs` in the config file, using "." for the project root itself, as on a plain HTML site',
    );
  });

  it('keeps the served-directory sentence for a project that found a root elsewhere', () => {
    const plan = planOptimization(
      input({
        assets: [asset('src/logo.png')],
        references: [resolved('src/App.jsx', './logo.png', 'src/logo.png')],
        publicPolicy: 'replace',
      }),
    );

    expect(plan.keptOriginals.map((kept) => kept.reason)).toEqual([
      expect.stringContaining('it is outside a directory this project serves'),
    ]);
  });
});
