import { describe, expect, it } from 'vitest';
import { audit } from './audit.js';
import type { Finding } from './audit.js';
import { buildGraph } from './graph.js';
import type { AssetProbe } from './probe.js';
import type { ReadFilePort } from './scan.js';
import { sweepForMentions } from './sweep.js';
import type { SweepResult } from './sweep.js';
import type { Asset, RawReference, Reference, UnscannedFile } from './types.js';

/**
 * The audit is pure over the graph, the sweep and the probe, so everything here is
 * built by hand. What each test is really asking is whether a person reading the
 * finding would be told the truth.
 */

const ROOT = '/repo';
const NO_SWEEP: SweepResult = { mentions: new Map(), skipped: [] };

function asset(relative: string, bytes = 1_000): Asset {
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

function broken(file: string, rawPath: string, start = 0): Reference {
  return {
    ...raw(file, rawPath, start),
    resolution: 'broken',
    confidence: 'unsafe',
    resolvedPath: null,
  };
}

function resolved(file: string, rawPath: string, target: string): Reference {
  return {
    ...raw(file, rawPath),
    resolution: 'resolved',
    confidence: 'high',
    resolvedPath: `${ROOT}/${target}`,
    resolvedVia: 'file',
  };
}

function probe(relative: string, over: Partial<AssetProbe> = {}): AssetProbe {
  return {
    relative,
    metadata: { width: 100, height: 100, format: 'png', pages: 1 },
    encoded: [],
    skipped: [],
    ...over,
  };
}

function files(contents: Record<string, string> = {}): ReadFilePort {
  return async (path) => {
    const text = contents[path];
    if (text === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return text;
  };
}

function graphOf(input: {
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

function kinds(findings: readonly Finding[]): string[] {
  return findings.map((finding) => finding.kind);
}

describe('audit', () => {
  describe('dead and possibly-dead', () => {
    it('reports an unreferenced asset as confidently dead when nothing mentions it', async () => {
      const result = await audit({
        graph: graphOf({ assets: [asset('orphan.png', 2_000)] }),
        sweep: NO_SWEEP,
        readFile: files(),
      });

      expect(result.findings).toEqual([
        { kind: 'dead', asset: 'orphan.png', bytes: 2_000, inPublicDir: false },
      ]);
    });

    it('hedges an asset an unread file mentions, carrying the evidence', async () => {
      const graph = graphOf({
        assets: [asset('hero.png')],
        unscannedFiles: [
          {
            path: `${ROOT}/config.yaml`,
            relative: 'config.yaml',
            extension: '.yaml',
            reason: 'unclaimed-extension',
            detail: '',
          },
        ],
      });
      const readFile = files({ '/repo/config.yaml': 'image: hero.png\n' });
      const sweep = await sweepForMentions({ graph, readFile });

      const result = await audit({ graph, sweep, readFile });

      expect(result.findings).toEqual([
        {
          kind: 'possibly-dead',
          asset: 'hero.png',
          bytes: 1_000,
          inPublicDir: false,
          evidence: [
            {
              asset: 'hero.png',
              source: 'unscanned-file',
              where: 'config.yaml:1',
              quote: 'hero.png',
            },
          ],
        },
      ]);
    });

    it('cites file, line and raw path for a hedge from an unresolved reference', async () => {
      // The R10 rider: this is the source that can name a line, and it must.
      const source = 'title: x\n\n![Hero]({{ site.url }}/img/hero.png)\n';
      const graph = graphOf({
        assets: [asset('img/hero.png')],
        references: [
          {
            ...raw('post.md', '{{ site.url }}/img/hero.png', source.indexOf('{{')),
            ceiling: 'unsafe',
            resolution: 'dynamic',
            confidence: 'unsafe',
            resolvedPath: null,
          },
        ],
      });
      const readFile = files({ '/repo/post.md': source });

      const result = await audit({
        graph,
        sweep: await sweepForMentions({ graph, readFile }),
        readFile,
      });

      const [finding] = result.findings;
      expect(finding?.kind).toBe('possibly-dead');
      expect(finding?.kind === 'possibly-dead' && finding.evidence[0]).toEqual({
        asset: 'img/hero.png',
        source: 'unresolved-reference',
        where: 'post.md:3',
        quote: '{{ site.url }}/img/hero.png',
      });
    });

    it('says nothing about an asset that is referenced', async () => {
      const result = await audit({
        graph: graphOf({
          assets: [asset('used.png')],
          references: [resolved('index.html', './used.png', 'used.png')],
        }),
        sweep: NO_SWEEP,
        readFile: files(),
      });

      expect(result.findings).toEqual([]);
    });
  });

  describe('the public-directory rider', () => {
    it('still reports a public asset as dead, and counts it', async () => {
      // A public asset may be referenced from outside the repo entirely, but that
      // is a bare possibility with no evidence — hedging on it is how the first
      // version of this rule degenerated. One caveat line instead.
      const result = await audit({
        graph: graphOf({ assets: [asset('public/promo.png'), asset('src/orphan.png')] }),
        sweep: NO_SWEEP,
        readFile: files(),
        publicDirs: ['public'],
      });

      expect(kinds(result.findings)).toEqual(['dead', 'dead']);
      expect(result.publicDirDeadCount).toBe(1);
      expect(
        result.findings.map((finding) => finding.kind === 'dead' && finding.inPublicDir),
      ).toEqual([true, false]);
    });

    it('counts everything as public when the project serves from its own root', async () => {
      // A hand-written static site with no build step uploads the repository, so
      // every file in it is reachable from outside and none of it can be called
      // safe to delete on the strength of the reference graph alone.
      //
      // This used to assert zero, on the reasoning that marking everything public
      // would make the caveat meaningless. The reasoning inverted the fact: the
      // caveat is least meaningful where it is silently absent. Measured on
      // railsgirls-com, which is in the corpus for precisely this property, it
      // suppressed the warning across 903 unreferenced assets.
      const result = await audit({
        graph: graphOf({ assets: [asset('images/orphan.png'), asset('deep/nested/logo.png')] }),
        sweep: NO_SWEEP,
        readFile: files(),
        publicDirs: [''],
      });

      expect(result.publicDirDeadCount).toBe(2);
      expect(result.findings.every((f) => f.kind !== 'dead' || f.inPublicDir)).toBe(true);
    });

    it('still counts nothing as public when the project serves nothing publicly', async () => {
      // The empty LIST and the empty STRING are opposites, and the distinction is
      // the whole of this rule: no public directories at all, against one public
      // directory that happens to be the project root.
      const result = await audit({
        graph: graphOf({ assets: [asset('images/orphan.png')] }),
        sweep: NO_SWEEP,
        readFile: files(),
        publicDirs: [],
      });

      expect(result.publicDirDeadCount).toBe(0);
    });

    it('does not count a hedged public asset — only confident ones need the caveat', async () => {
      const graph = graphOf({
        assets: [asset('public/hero.png')],
        unscannedFiles: [
          {
            path: `${ROOT}/page.vue`,
            relative: 'page.vue',
            extension: '.vue',
            reason: 'unclaimed-extension',
            detail: '',
          },
        ],
      });
      const readFile = files({ '/repo/page.vue': '<img src="/hero.png">' });

      const result = await audit({
        graph,
        sweep: await sweepForMentions({ graph, readFile }),
        readFile,
        publicDirs: ['public'],
      });

      expect(kinds(result.findings)).toEqual(['possibly-dead']);
      expect(result.publicDirDeadCount).toBe(0);
    });
  });

  describe('broken', () => {
    it('cites the line so a reviewer can open it', async () => {
      // §5.1(d) says every broken finding gets opened by a human. A path without a
      // line makes that a grep instead of a click.
      const source = '<html>\n  <body>\n    <img src="./missing.png">\n  </body>\n</html>\n';
      const graph = graphOf({
        assets: [],
        references: [broken('index.html', './missing.png', source.indexOf('./missing'))],
      });

      const result = await audit({
        graph,
        sweep: NO_SWEEP,
        readFile: files({ '/repo/index.html': source }),
      });

      expect(result.findings).toEqual([
        {
          kind: 'broken',
          file: 'index.html',
          line: 3,
          where: 'index.html:3',
          rawPath: './missing.png',
        },
      ]);
    });

    it('still reports the finding when the source cannot be re-read', async () => {
      // Losing the line must not lose the finding — that would be a silent skip of
      // the one finding the exit criterion is about.
      const graph = graphOf({ references: [broken('gone.html', './missing.png')] });

      const result = await audit({ graph, sweep: NO_SWEEP, readFile: files() });

      expect(result.findings).toEqual([
        {
          kind: 'broken',
          file: 'gone.html',
          line: null,
          where: 'gone.html',
          rawPath: './missing.png',
        },
      ]);
      expect(result.unreadableSources).toEqual([{ relative: 'gone.html', reason: 'ENOENT' }]);
    });

    it('reads a file once however many broken references it holds', async () => {
      let reads = 0;
      const source = 'a ./one.png\nb ./two.png\n';
      const graph = graphOf({
        references: [
          broken('page.html', './one.png', source.indexOf('./one')),
          broken('page.html', './two.png', source.indexOf('./two')),
        ],
      });

      const result = await audit({
        graph,
        sweep: NO_SWEEP,
        readFile: async () => {
          reads += 1;
          return source;
        },
      });

      expect(reads).toBe(1);
      expect(result.findings.map((finding) => finding.kind === 'broken' && finding.line)).toEqual([
        1, 2,
      ]);
    });
  });

  describe('oversized', () => {
    it('reports an asset past the byte limit', async () => {
      const result = await audit({
        graph: graphOf({
          assets: [asset('huge.png', 900_000)],
          references: [resolved('a.html', './huge.png', 'huge.png')],
        }),
        sweep: NO_SWEEP,
        readFile: files(),
        probes: [probe('huge.png')],
      });

      expect(result.findings).toEqual([
        {
          kind: 'oversized',
          asset: 'huge.png',
          bytes: 900_000,
          width: 100,
          height: 100,
          exceeded: ['bytes'],
        },
      ]);
    });

    it('reports every limit an asset exceeds, in a stable order', async () => {
      const result = await audit({
        graph: graphOf({
          assets: [asset('huge.png', 900_000)],
          references: [resolved('a.html', './huge.png', 'huge.png')],
        }),
        sweep: NO_SWEEP,
        readFile: files(),
        probes: [
          probe('huge.png', { metadata: { width: 9_000, height: 8_000, format: 'png', pages: 1 } }),
        ],
      });

      expect(result.findings[0]?.kind === 'oversized' && result.findings[0].exceeded).toEqual([
        'bytes',
        'height',
        'width',
      ]);
    });

    it('still reports an oversized asset whose header would not decode', async () => {
      // A corrupt 40 MB file is exactly the asset a user most wants told about.
      const result = await audit({
        graph: graphOf({
          assets: [asset('corrupt.png', 40_000_000)],
          references: [resolved('a.html', './corrupt.png', 'corrupt.png')],
        }),
        sweep: NO_SWEEP,
        readFile: files(),
        probes: [probe('corrupt.png', { metadata: null })],
      });

      expect(result.findings[0]).toMatchObject({ kind: 'oversized', width: null, height: null });
    });

    it('honours configured thresholds', async () => {
      const result = await audit({
        graph: graphOf({
          assets: [asset('small.png', 2_000)],
          references: [resolved('a.html', './small.png', 'small.png')],
        }),
        sweep: NO_SWEEP,
        readFile: files(),
        probes: [probe('small.png')],
        thresholds: { maxBytes: 1_000 },
      });

      expect(kinds(result.findings)).toEqual(['oversized']);
    });
  });

  describe('format opportunities', () => {
    it('reports a measured saving', async () => {
      const result = await audit({
        graph: graphOf({
          assets: [asset('hero.png', 100_000)],
          references: [resolved('a.html', './hero.png', 'hero.png')],
        }),
        sweep: NO_SWEEP,
        readFile: files(),
        probes: [probe('hero.png', { encoded: [{ format: 'webp', bytes: 40_000, quality: 80 }] })],
      });

      expect(result.findings).toEqual([
        {
          kind: 'format-opportunity',
          quality: 80,
          asset: 'hero.png',
          from: 'png',
          to: 'webp',
          bytes: 100_000,
          wouldBe: 40_000,
          savedBytes: 60_000,
          savedPercent: 60,
        },
      ]);
    });

    it('reports a big file that shrinks only a little', async () => {
      // The correction: 9% of 8 MB is 720 KB, very likely the largest single win
      // in the repository. A percentage-only rule hides exactly this finding.
      const result = await audit({
        graph: graphOf({
          assets: [asset('hero.jpg', 8_000_000)],
          references: [resolved('a.html', './hero.jpg', 'hero.jpg')],
        }),
        sweep: NO_SWEEP,
        readFile: files(),
        probes: [
          probe('hero.jpg', { encoded: [{ format: 'webp', bytes: 7_280_000, quality: 80 }] }),
        ],
      });

      // It is also `oversized` at 8 MB, which is correct and not what this asserts.
      expect(result.findings.filter((finding) => finding.kind === 'format-opportunity')).toEqual([
        {
          kind: 'format-opportunity',
          quality: 80,
          asset: 'hero.jpg',
          from: 'png',
          to: 'webp',
          bytes: 8_000_000,
          wouldBe: 7_280_000,
          savedBytes: 720_000,
          savedPercent: 9,
        },
      ]);
    });

    it('reports a small file that shrinks a lot', async () => {
      // The other arm: 60% of 100 KB is where the percentage is the meaningful
      // number and the byte count alone would not clear the absolute arm.
      const result = await audit({
        graph: graphOf({
          assets: [asset('logo.png', 100_000)],
          references: [resolved('a.html', './logo.png', 'logo.png')],
        }),
        sweep: NO_SWEEP,
        readFile: files(),
        probes: [probe('logo.png', { encoded: [{ format: 'webp', bytes: 40_000, quality: 80 }] })],
      });

      expect(kinds(result.findings)).toEqual(['format-opportunity']);
    });

    it('ignores a saving that clears neither arm', async () => {
      const result = await audit({
        graph: graphOf({
          assets: [asset('hero.png', 100_000)],
          references: [resolved('a.html', './hero.png', 'hero.png')],
        }),
        sweep: NO_SWEEP,
        readFile: files(),
        probes: [probe('hero.png', { encoded: [{ format: 'webp', bytes: 95_000, quality: 80 }] })],
      });

      expect(result.findings).toEqual([]);
    });

    it('ignores a large percentage of a tiny file', async () => {
      // 40% of a 200-byte icon is 80 bytes. Reporting it pushes the findings
      // someone can act on further down the page.
      const result = await audit({
        graph: graphOf({
          assets: [asset('icon.png', 200)],
          references: [resolved('a.html', './icon.png', 'icon.png')],
        }),
        sweep: NO_SWEEP,
        readFile: files(),
        probes: [probe('icon.png', { encoded: [{ format: 'webp', bytes: 120, quality: 80 }] })],
      });

      expect(result.findings).toEqual([]);
    });

    it('never reports a saving that was not measured', async () => {
      // The probe declined to encode this one; there is no number, so there is no
      // finding. An estimate here would be exactly what the build plan forbids.
      const result = await audit({
        graph: graphOf({
          assets: [asset('icon.svg', 90_000)],
          references: [resolved('a.html', './icon.svg', 'icon.svg')],
        }),
        sweep: NO_SWEEP,
        readFile: files(),
        probes: [
          probe('icon.svg', {
            metadata: { width: 10, height: 10, format: 'svg', pages: 1 },
            skipped: [{ measurement: 'webp', code: 'vector', reason: 'SVG is a vector' }],
          }),
        ],
      });

      expect(kinds(result.findings)).toEqual([]);
    });

    it('reports one finding per measured format', async () => {
      const result = await audit({
        graph: graphOf({
          assets: [asset('hero.png', 100_000)],
          references: [resolved('a.html', './hero.png', 'hero.png')],
        }),
        sweep: NO_SWEEP,
        readFile: files(),
        probes: [
          probe('hero.png', {
            encoded: [
              { format: 'avif', bytes: 20_000, quality: 80 },
              { format: 'webp', bytes: 40_000, quality: 80 },
            ],
          }),
        ],
      });

      expect(
        result.findings.map((finding) => finding.kind === 'format-opportunity' && finding.to),
      ).toEqual(['avif', 'webp']);
    });
  });

  describe('what happens without a probe', () => {
    it('produces the three cheap findings and says it did not probe', async () => {
      // The property that makes the cap and `--no-probe` safe: three findings of
      // four need no pixels at all.
      const source = '<img src="./missing.png">';
      const result = await audit({
        graph: graphOf({
          assets: [asset('orphan.png', 900_000)],
          references: [broken('index.html', './missing.png', source.indexOf('./'))],
        }),
        sweep: NO_SWEEP,
        readFile: files({ '/repo/index.html': source }),
      });

      expect(kinds(result.findings)).toEqual(['broken', 'dead']);
      expect(result.probed).toBe(false);
      // No oversized finding, even though the asset is over the byte limit: the
      // report says "not probed" rather than showing a zero that reads as "clean".
      expect(kinds(result.findings)).not.toContain('oversized');
    });
  });

  describe('report order', () => {
    it('groups by kind, then by subject', async () => {
      const source = './missing.png';
      const result = await audit({
        graph: graphOf({
          assets: [asset('z-orphan.png', 900_000), asset('a-orphan.png')],
          references: [broken('index.html', './missing.png', 0)],
        }),
        sweep: NO_SWEEP,
        readFile: files({ '/repo/index.html': source }),
        probes: [probe('z-orphan.png'), probe('a-orphan.png')],
      });

      expect(
        result.findings.map((finding) => [finding.kind, 'asset' in finding && finding.asset]),
      ).toEqual([
        ['broken', false],
        ['dead', 'a-orphan.png'],
        ['dead', 'z-orphan.png'],
        ['oversized', 'z-orphan.png'],
      ]);
    });

    it('produces the same findings however the inputs are ordered', async () => {
      const assets = [asset('a.png', 900_000), asset('b.png', 900_000)];
      const probes = [probe('a.png'), probe('b.png')];

      const forwards = await audit({
        graph: graphOf({ assets }),
        sweep: NO_SWEEP,
        readFile: files(),
        probes,
      });
      const backwards = await audit({
        graph: graphOf({ assets: [...assets].reverse() }),
        sweep: NO_SWEEP,
        readFile: files(),
        probes: [...probes].reverse(),
      });

      expect(backwards.findings).toEqual(forwards.findings);
    });
  });

  describe('assets a framework reads by filename (R17)', () => {
    const CONVENTION = 'apps/v4/app/(app)/sera/opengraph-image.jpg';
    const ROOTS = [{ framework: 'next', dir: 'apps/v4' }] as const;

    function auditWith(conventionRoots: readonly { framework: 'next'; dir: string }[]) {
      return audit({
        graph: graphOf({ assets: [asset(CONVENTION), asset('apps/v4/public/orphan.png')] }),
        sweep: NO_SWEEP,
        readFile: files(),
        conventionRoots,
      });
    }

    it('reports it dead when nothing says otherwise — the check that can fail', async () => {
      // Deliberately first. Everything below asserts that a mechanism *suppresses* a
      // finding, and an assertion like that passes just as well when the finding was
      // never produced. This is the control: with no roots detected, the same asset
      // is reported dead, so the tests underneath are measuring the mechanism rather
      // than an empty list.
      const result = await auditWith([]);

      expect(result.findings.filter((finding) => finding.kind === 'dead')).toHaveLength(2);
      expect(result.conventionLinked).toEqual([]);
    });

    it('does not report it dead once the framework is known', async () => {
      const result = await auditWith(ROOTS);
      const dead = result.findings.filter((finding) => finding.kind === 'dead');

      expect(dead.map((finding) => finding.kind === 'dead' && finding.asset)).toEqual([
        'apps/v4/public/orphan.png',
      ]);
    });

    it('does not hedge it either — a hedge would be evasive, not weaker', async () => {
      // `possibly-dead` means *we do not know*. Here we do: Next will emit it. R17
      // rejected hedging for exactly that reason.
      const result = await auditWith(ROOTS);

      expect(result.findings.some((finding) => finding.kind === 'possibly-dead')).toBe(false);
    });

    it('accounts for it rather than dropping it, because a silent skip is a P0', async () => {
      // Rule 9, and it is also arithmetic: the asset has zero references, so the
      // headline counts it as unreferenced. Without this list the report would show
      // one more unreferenced image than it has findings and explain the gap
      // nowhere.
      const result = await auditWith(ROOTS);

      expect(result.conventionLinked).toEqual([
        { asset: CONVENTION, reason: expect.stringContaining('Next.js reads') },
      ]);
    });
  });

  it('audits an empty project without complaint', async () => {
    const result = await audit({ graph: graphOf({}), sweep: NO_SWEEP, readFile: files() });

    expect(result).toEqual({
      findings: [],
      publicDirDeadCount: 0,
      conventionLinked: [],
      unreadableSources: [],
      probed: false,
    });
  });
});

describe('a run that could not find the serving root', () => {
  /** `n` root-relative references, of which `linkedCount` resolve. */
  function rootRelative(n: number, linkedCount: number) {
    const assets: Asset[] = [];
    const references: Reference[] = [];
    for (let index = 0; index < n; index++) {
      if (index < linkedCount) {
        assets.push(asset(`public/a${index}.png`));
        references.push(resolved('index.html', `/a${index}.png`, `public/a${index}.png`));
      } else {
        references.push(broken('index.html', `/missing${index}.png`, index * 40));
      }
    }
    return { assets, references };
  }

  it('reports one diagnosis instead of every symptom', async () => {
    // The R51 ruling. When almost nothing root-relative resolves, the finding is not
    // that these references are broken; it is that we do not know where the project
    // serves files from, and 14 broken findings whose targets are all on disk is a
    // symptom reported as a diagnosis.
    const { assets, references } = rootRelative(20, 1);

    const result = await audit({
      graph: graphOf({ assets, references }),
      sweep: NO_SWEEP,
      readFile: files(),
    });

    expect(kinds(result.findings)).toEqual(['serving-root-unknown']);
    expect(result.findings[0]).toMatchObject({
      kind: 'serving-root-unknown',
      linked: 1,
      checkable: 20,
      suppressedBroken: 19,
    });
  });

  it('carries the count of what it replaced, so nothing vanishes silently', async () => {
    // Rule 9. The references themselves are still itemised in the report's own
    // references section, so this re-explains them rather than hiding them.
    const { assets, references } = rootRelative(30, 2);

    const result = await audit({
      graph: graphOf({ assets, references }),
      sweep: NO_SWEEP,
      readFile: files(),
    });

    const [finding] = result.findings;
    expect(finding).toMatchObject({ kind: 'serving-root-unknown', suppressedBroken: 28 });
  });

  it('keeps a broken relative reference that the diagnosis does not explain', async () => {
    // Measured on unconfigured shadcn-ui: 116 broken findings, 115 of them
    // root-relative. The first version of this suppressed all 116, and the odd one out
    // was a genuinely broken relative path that would still be broken with the serving
    // root corrected. Hiding it behind an unrelated explanation leaves the user with
    // no way to see it at all.
    const { assets, references } = rootRelative(20, 1);
    const alsoBroken = broken('index.html', './genuinely-gone.png', 9_000);

    const result = await audit({
      graph: graphOf({ assets, references: [...references, alsoBroken] }),
      sweep: NO_SWEEP,
      readFile: files(),
    });

    expect(kinds(result.findings)).toEqual(['serving-root-unknown', 'broken']);
    expect(result.findings[0]).toMatchObject({ suppressedBroken: 19 });
    expect(result.findings[1]).toMatchObject({ rawPath: './genuinely-gone.png' });
  });

  it('leaves an ordinary run alone, broken findings and all', async () => {
    const { assets, references } = rootRelative(20, 19);

    const result = await audit({
      graph: graphOf({ assets, references }),
      sweep: NO_SWEEP,
      readFile: files(),
    });

    expect(kinds(result.findings)).toEqual(['broken']);
  });

  it('does not suppress genuinely broken relative references', async () => {
    // A repository whose relative paths are broken is not a repository whose serving
    // root is unknown, and it keeps every finding.
    const references = Array.from({ length: 40 }, (_, index) =>
      broken('index.html', `./gone${index}.png`, index * 40),
    );

    const result = await audit({
      graph: graphOf({ references }),
      sweep: NO_SWEEP,
      readFile: files(),
    });

    expect(new Set(kinds(result.findings))).toEqual(new Set(['broken']));
    expect(result.findings).toHaveLength(40);
  });
});
