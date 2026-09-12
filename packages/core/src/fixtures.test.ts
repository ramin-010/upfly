import { existsSync } from 'node:fs';
import { readFile as readFile_ } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defaultAdapters } from './adapters/default-adapters.js';
import { audit } from './audit.js';
import { discover } from './discover.js';
import { buildGraph, unreferencedAssets } from './graph.js';
import { createSharpProbe } from './probe-sharp.js';
import { probeAssets } from './probe.js';
import { isLinked } from './reference.js';
import { MINIMUM_ROOT_RELATIVE, resolutionHealth } from './resolution-health.js';
import { resolveReferences } from './resolve.js';
import { scanSources } from './scan.js';
import type { ReadFilePort } from './scan.js';
import { detectServingRoots } from './serving-roots.js';
import { sweepForMentions } from './sweep.js';
import type { Adapter, Reference } from './types.js';

/**
 * The framework fixtures, exercised end to end through `discover` and the adapters.
 *
 * This is not yet the Phase 1 exit gate — that is the full validation protocol in
 * build plan §5.1, and it needs the resolver, the graph and a human. What this does
 * prove is that the trees are internally consistent, that every file an adapter
 * claims actually parses, and that no reference points at the wrong bytes.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures');

const ADAPTERS: readonly Adapter[] = defaultAdapters;

const NAMES = ['vite-react', 'next-app', 'astro', 'plain-html', 'eleventy'] as const;

/** Where each tree serves a root-relative `/hero.png` from. */
const PUBLIC_DIRS: Record<(typeof NAMES)[number], string> = {
  'vite-react': 'public',
  'next-app': 'public',
  astro: 'public',
  // A plain static site serves from the project root itself.
  'plain-html': '',
  // Eleventy passes `src/img` through to `/img`.
  eleventy: 'src',
};

async function scan(name: string) {
  const root = join(FIXTURES, name);
  const discovered = await discover({ root, adapters: ADAPTERS });

  const scanned = await scanSources({
    sourceFiles: discovered.sourceFiles,
    adapters: ADAPTERS,
    readFile: (path) => readFile_(path, 'utf8'),
  });

  // Kept separately from `scanSources`, which deliberately does not hold a whole
  // repository's source in memory. The range invariant below needs the text, and a
  // fixture tree is small enough that a test can afford it.
  const sources = new Map<string, string>();
  for (const sourceFile of discovered.sourceFiles) {
    sources.set(sourceFile.path, await readFile_(sourceFile.path, 'utf8'));
  }

  return { discovered, references: scanned.references, unscanned: scanned.unscanned, sources };
}

async function resolveTree(name: (typeof NAMES)[number]): Promise<Reference[]> {
  const { discovered, references } = await scan(name);
  return resolveReferences(references, {
    root: discovered.root,
    assets: discovered.assets,
    servingRoots: { declared: true, dirs: [PUBLIC_DIRS[name] ?? 'public'] },
    excludedRoots: discovered.excludedRoots,
    // The real port here: these are real trees, and a reference that would be
    // called broken deserves the one stat that proves it.
    exists: (path) => existsSync(path),
  });
}

/**
 * A filename that announces the asset is meant to have no references.
 *
 * The dead half of the §5.1(h) convention — its reference half lives in
 * `fixture-integrity.test.ts`. `removed.png` belongs here too: it is referenced
 * only from inside an HTML comment, which is precisely what that fixture tests.
 */
const DELIBERATELY_DEAD = /orphan|unused|unreferenced|never-|removed/;

describe('framework fixtures', () => {
  it.each(NAMES)('%s: discovery finds assets and source files', async (name) => {
    const { discovered } = await scan(name);

    expect(discovered.assets.length).toBeGreaterThan(0);
    expect(discovered.sourceFiles.length).toBeGreaterThan(0);
    // Nothing in a checked-in fixture should be unreadable or a symlink.
    expect(discovered.skipped).toEqual([]);
  });

  it.each(NAMES)('%s: every claimed source file parses', async (name) => {
    // An adapter throwing here would mean a fixture the engine cannot read at all,
    // which would quietly shrink what the rest of the phase is validated against.
    await expect(scan(name)).resolves.toBeDefined();
  });

  it.each(NAMES)('%s: finds references', async (name) => {
    const { references } = await scan(name);
    expect(references.length).toBeGreaterThan(0);
  });

  it.each(NAMES)('%s: every reference range selects exactly its own path', async (name) => {
    // The invariant that kills the whole class of offset bugs. §5.1(a) makes this a
    // property test over real repos too; this is the fixture half of it.
    const { references, sources } = await scan(name);

    for (const reference of references) {
      const text = sources.get(reference.file);
      expect(text).toBeDefined();
      expect(text?.slice(reference.start, reference.end)).toBe(reference.rawPath);
    }
  });

  describe('resolved against the assets that exist', () => {
    it.each(NAMES)('%s: no reference is wrongly reported broken', async (name) => {
      // The shape of the phase's exit criterion, at fixture scale. Every `broken`
      // here must be one the fixture declares in its own filename.
      const broken = (await resolveTree(name))
        .filter((reference) => reference.resolution === 'broken')
        .map((reference) => reference.rawPath);

      expect(broken.filter((path) => !path.includes('missing-on-purpose'))).toEqual([]);
    });

    it.each(NAMES)('%s: links assets', async (name) => {
      const resolved = (await resolveTree(name)).filter(isLinked);
      expect(resolved.length).toBeGreaterThan(0);
    });

    it('keeps the one deliberately broken reference, so the check has teeth', async () => {
      const broken = (await resolveTree('plain-html')).filter(
        (reference) => reference.resolution === 'broken',
      );
      expect(broken.map((reference) => reference.rawPath)).toEqual([
        'images/missing-on-purpose.png',
      ]);
    });

    it('reports a templated eleventy path as dynamic rather than broken', async () => {
      const dynamic = (await resolveTree('eleventy')).filter(
        (reference) => reference.resolution === 'dynamic',
      );
      expect(dynamic.map((reference) => reference.rawPath)).toEqual([
        '{{ site.url }}/img/templated.png',
      ]);
    });

    it('drops non-asset references rather than reporting them', async () => {
      // vite-react references `.css`, `.jsx` and `.svg`; only the svg is tracked.
      const { references } = await scan('vite-react');
      const resolved = await resolveTree('vite-react');
      expect(resolved.length).toBeLessThan(references.length);
      expect(resolved.every((reference) => reference.rawPath.includes('.css'))).toBe(false);
    });
  });

  describe('linked into a graph', () => {
    async function graphTree(name: (typeof NAMES)[number]) {
      const { discovered, unscanned } = await scan(name);
      return buildGraph({
        root: discovered.root,
        assets: discovered.assets,
        references: await resolveTree(name),
        // Both sources, always. Discovery's unclaimed extensions and scan's parse
        // failures are one condition to the audit: we did not read that file.
        unscannedFiles: [...discovered.unscannedFiles, ...unscanned],
      });
    }

    it.each(NAMES)('%s: every asset becomes a node and no reference is lost', async (name) => {
      const { discovered } = await scan(name);
      const graph = await graphTree(name);
      const resolved = await resolveTree(name);

      expect(graph.assets).toHaveLength(discovered.assets.length);
      expect(graph.references).toHaveLength(resolved.length);
      // Rule 9 at the layer most likely to lose one: every reference is in exactly
      // one bucket, so it cannot vanish from the report without vanishing here.
      expect(Object.values(graph.byResolution).flat()).toHaveLength(resolved.length);
    });

    it.each(NAMES)(
      '%s: every unreferenced asset is declared dead or named in a file we could not read',
      async (name) => {
        // The R8 mechanism at fixture scale, before the audit that will implement
        // it exists. An asset with zero references is either deliberate — the
        // fixture says so in its filename, per §5.1(h) — or it is mentioned in a
        // file no adapter read, which is what makes it `possibly-dead` rather than
        // a false `dead` finding we manufactured ourselves.
        const graph = await graphTree(name);
        const mentioned = new Set<string>();
        const haystack = [
          ...(await Promise.all(graph.unscannedFiles.map((file) => readFile_(file.path, 'utf8')))),
          // The second half, found by this very test on the eleventy tree and
          // raised as R10: a reference we *read* but could not resolve names no
          // asset, so an asset it may point at looks dead. `templated.png` is
          // referenced by `![](({{ site.url }}/img/templated.png)` in a file we
          // parsed perfectly — it is `dynamic`, not missing, and reporting it dead
          // is the same manufactured false positive from the other direction.
          ...graph.byResolution.dynamic.map((reference) => reference.rawPath),
          ...graph.byResolution['unresolved-alias'].map((reference) => reference.rawPath),
          ...graph.byResolution.discarded.map((reference) => reference.rawPath),
        ];

        for (const text of haystack) {
          for (const node of graph.assets) {
            if (text.includes(basename(node.asset.relative))) {
              mentioned.add(node.asset.relative);
            }
          }
        }

        const unexplained = unreferencedAssets(graph)
          .map((node) => node.asset.relative)
          .filter((relative) => !DELIBERATELY_DEAD.test(relative) && !mentioned.has(relative));

        expect(unexplained).toEqual([]);
      },
    );

    it('links all three astro assets now that an adapter reads .astro', async () => {
      // ⚠️ This test used to assert the opposite, and the inversion is the point of
      // B1. `logo.png` (a fence import), `favicon.png` (a `<link rel=icon>`) and
      // `banner.png` (an `<img src>`) had zero references for a reason that had
      // nothing to do with the assets: no adapter read the file naming them. All
      // three are ordinary links now, and the tree has no unread file types left.
      //
      // Both halves of the file are represented here on purpose — the import comes
      // from the frontmatter fence and the other two from the template body — so a
      // fence-only or body-only adapter would fail this.
      const graph = await graphTree('astro');

      expect(graph.unscannedExtensions).toEqual([]);
      expect(unreferencedAssets(graph).map((node) => node.asset.relative)).toEqual([
        'public/never-used.png',
      ]);
    });

    it('reports two eleventy templates as unread', async () => {
      const graph = await graphTree('eleventy');

      expect(graph.unscannedExtensions).toEqual([{ ext: '.njk', fileCount: 2 }]);
    });

    it('counts an SVG as unread even though it is also an asset', async () => {
      // An SVG can carry `<image href="hero.png">`, and no adapter reads one. It is
      // both an asset and a file we did not scan.
      //
      // Two of them: `public/favicon.svg` is referenced and `src/assets/unused-icon.svg`
      // is not. The second was added for R22, whose demotion no fixture tree reached —
      // every one of the five produced `unusedVectors.count: 0`, which is the stated
      // condition under which fixtures cannot test a thing at all.
      const graph = await graphTree('vite-react');

      expect(graph.unscannedExtensions).toEqual([{ ext: '.svg', fileCount: 2 }]);
      expect(graph.assets.some((node) => node.asset.relative.endsWith('.svg'))).toBe(true);
    });

    it.each(['next-app', 'plain-html'] as const)(
      '%s: was read completely, so a dead finding needs no hedge',
      async (name) => {
        // The case the amended rule reserves `dead` for. Rare in the wild, which is
        // why hedging had to become per-asset rather than global — but it exists,
        // and both branches are reachable at fixture scale.
        expect((await graphTree(name)).unscannedExtensions).toEqual([]);
      },
    );

    describe('the sweep that decides dead against possibly-dead', () => {
      async function sweep(name: (typeof NAMES)[number]) {
        return sweepForMentions({
          graph: await graphTree(name),
          readFile: (path) => readFile_(path, 'utf8'),
        });
      }

      it('has nothing left to rescue in the astro tree', async () => {
        // ⚠️ Inverted by B1. This was haystack (a)'s end-to-end case: three assets
        // named only by an unread `.astro` file. They are linked now, so the sweep
        // correctly finds nothing — a hedge here would be the engine hedging about
        // a reference it can follow perfectly well.
        //
        // Haystack (a) has NOT lost its coverage: `sweep.test.ts` exercises it
        // directly, and the eleventy tree still names assets only from unread `.njk`
        // templates — see "rescues the eleventy assets that only .njk templates
        // reference" below. That was checked rather than assumed before this test
        // was changed.
        const { mentions } = await sweep('astro');

        expect([...mentions.keys()].sort()).toEqual([]);
      });

      it('leaves astro-s deliberately dead asset confidently dead', async () => {
        // The other half, and the reason a per-asset hedge is worth the work:
        // `never-used.png` is in the same tree and is not rescued.
        const { mentions } = await sweep('astro');

        expect(mentions.has('public/never-used.png')).toBe(false);
      });

      it('rescues the eleventy asset R10 was raised for, citing file and line', async () => {
        // Haystack (b). `first.md` parsed perfectly; the reference is `dynamic`,
        // so it links nothing and the asset looked confidently dead.
        const { mentions } = await sweep('eleventy');

        expect(mentions.get('src/img/templated.png')).toEqual([
          {
            asset: 'src/img/templated.png',
            source: 'unresolved-reference',
            where: 'src/posts/first.md:7',
            quote: '{{ site.url }}/img/templated.png',
          },
        ]);
      });

      it('rescues the eleventy assets that only .njk templates reference', async () => {
        const { mentions } = await sweep('eleventy');

        expect(mentions.get('src/img/logo.png')?.[0]?.where).toBe('src/index.njk:5');
        expect(mentions.get('src/img/favicon.png')?.[0]?.where).toBe('src/_includes/base.njk:4');
        expect(mentions.has('src/img/unused.png')).toBe(false);
      });

      it.each(['next-app', 'plain-html'] as const)(
        '%s: every unreferenced asset stays confidently dead',
        async (name) => {
          // Fully scanned trees, and nothing unresolved names these — so `dead`
          // is reachable, which is the whole point of amending the global hedge.
          const { mentions, skipped } = await sweep(name);

          expect(mentions.size).toBe(0);
          expect(skipped).toEqual([]);
        },
      );

      it.each(NAMES)('%s: reads nothing it cannot account for', async (name) => {
        expect((await sweep(name)).skipped).toEqual([]);
      });
    });

    describe('audited end to end', () => {
      async function auditTree(name: (typeof NAMES)[number], probed = true) {
        const graph = await graphTree(name);
        const readFile: ReadFilePort = (path) => readFile_(path, 'utf8');
        return audit({
          graph,
          sweep: await sweepForMentions({ graph, readFile }),
          readFile,
          publicDirs: [PUBLIC_DIRS[name] ?? 'public'],
          ...(probed
            ? {
                probes: await probeAssets(
                  graph.assets.map((node) => node.asset),
                  { probe: await createSharpProbe(), formats: ['webp'] },
                ),
              }
            : {}),
        });
      }

      it.each(NAMES)(
        '%s: reports no broken reference the fixture did not declare',
        async (name) => {
          // The exit criterion, now at the layer a user actually reads.
          const result = await auditTree(name, false);
          const broken = result.findings.filter((finding) => finding.kind === 'broken');

          expect(
            broken.filter((finding) => !finding.rawPath.includes('missing-on-purpose')),
          ).toEqual([]);
        },
      );

      it('cites the one deliberately broken reference at its line', async () => {
        const result = await auditTree('plain-html', false);

        expect(result.findings.filter((finding) => finding.kind === 'broken')).toEqual([
          {
            kind: 'broken',
            // Verified against the fixture: the deliberate dangling reference lives
            // in about.html, not index.html, and the citation lands on its line.
            file: 'about.html',
            line: 10,
            where: 'about.html:10',
            rawPath: 'images/missing-on-purpose.png',
          },
        ]);
      });

      it('reports astro-s one genuinely unused asset as dead, and hedges nothing', async () => {
        // ⚠️ Inverted by B1: three hedges became zero. The one asset nothing names
        // is still `dead`, which is what stops this reading as "the adapter made the
        // findings go away" -- coverage removed three FALSE hedges and left the true
        // finding untouched.
        const result = await auditTree('astro', false);
        const dead = result.findings.filter((finding) => finding.kind === 'dead');
        const hedged = result.findings.filter((finding) => finding.kind === 'possibly-dead');

        expect(hedged).toEqual([]);
        expect(dead.map((finding) => finding.asset)).toEqual(['public/never-used.png']);
      });

      it('counts a dead public asset for the caveat instead of hedging it', async () => {
        // The rider: `never-used.png` is under `public/`, so it could in principle
        // be referenced from outside the repo — but there is no evidence, so it
        // stays `dead` and the report carries a count.
        const result = await auditTree('astro', false);

        expect(result.publicDirDeadCount).toBe(1);
      });

      it.each(['next-app', 'plain-html'] as const)(
        '%s: every unreferenced asset is confidently dead',
        async (name) => {
          const result = await auditTree(name, false);

          expect(result.findings.some((finding) => finding.kind === 'possibly-dead')).toBe(false);
          expect(result.findings.some((finding) => finding.kind === 'dead')).toBe(true);
        },
      );

      it('produces dead and broken findings without a probe at all', async () => {
        // Three findings of four need no pixels — what makes `--no-probe` and a
        // low encode cap safe rather than merely fast.
        const result = await auditTree('plain-html', false);

        expect(result.probed).toBe(false);
        expect(result.findings.some((finding) => finding.kind === 'broken')).toBe(true);
        expect(result.findings.some((finding) => finding.kind === 'dead')).toBe(true);
      });

      it('reports a saving on the real fixture images, and every figure is arithmetic', async () => {
        // ⚠️ This assertion used to be its own opposite: the fixture images were 1x1,
        // so it asserted that NO opportunity was found. That was a fair test of "do
        // not estimate" and it also meant the fixtures could not exercise conversion
        // at all, which is the hole R53 was about.
        //
        // The half worth keeping is that every number is measured rather than guessed,
        // so it now checks the arithmetic of each finding against itself. An estimate
        // would have no reason to be self-consistent to the byte.
        const result = await auditTree('plain-html');
        const opportunities = result.findings.filter(
          (finding) => finding.kind === 'format-opportunity',
        );

        expect(result.probed).toBe(true);
        expect(opportunities.length).toBeGreaterThan(0);

        for (const finding of opportunities) {
          if (finding.kind !== 'format-opportunity') continue;
          expect(finding.wouldBe).toBeGreaterThan(0);
          expect(finding.wouldBe).toBeLessThan(finding.bytes);
          expect(finding.savedBytes).toBe(finding.bytes - finding.wouldBe);
        }

        // Still nothing oversized: real photographs, but small ones.
        expect(result.findings.some((finding) => finding.kind === 'oversized')).toBe(false);
      });

      it.each(NAMES)('%s: accounts for every source it could not read', async (name) => {
        expect((await auditTree(name, false)).unreadableSources).toEqual([]);
      });
    });

    it('links a CSS-only reference, so the asset is not dead', async () => {
      // `unused-in-css.png` is named for the trap: unused in JSX, referenced from a
      // stylesheet. An engine that only read components would call it dead.
      const graph = await graphTree('vite-react');
      const node = graph.assets.find((entry) => entry.asset.relative.endsWith('unused-in-css.png'));

      expect(node?.references.length).toBeGreaterThan(0);
    });
  });

  it('covers the adapters the compatibility matrix claims', async () => {
    const seen = new Set<string>();
    for (const name of NAMES) {
      const { discovered } = await scan(name);
      for (const sourceFile of discovered.sourceFiles) seen.add(sourceFile.adapterId);
    }

    expect([...seen].sort()).toEqual(['astro', 'css', 'html', 'javascript', 'json', 'markdown']);
  });

  it('claims .astro and still leaves .njk unclaimed, which is the remaining gap', async () => {
    // ⚠️ Half of this test inverted. `.astro` is claimed as of B1; `.njk` is still
    // an empty cell in the compatibility matrix and an intended community
    // contribution (§1.5, §5 Phase 5).
    //
    // The `.njk` half is kept rather than dropped because it is the assertion that
    // can still fail: a test that only says "everything is claimed" stops being able
    // to notice the next gap.
    const astro = await scan('astro');
    const eleventy = await scan('eleventy');

    expect(astro.discovered.sourceFiles.some((file) => file.relative.endsWith('.astro'))).toBe(
      true,
    );
    expect(eleventy.discovered.sourceFiles.some((file) => file.relative.endsWith('.njk'))).toBe(
      false,
    );
  });
});

/**
 * R58 — the serving-root diagnosis, exercised by a fixture for the first time.
 *
 * `resolutionHealth` suppresses findings, which makes it the most dangerous behaviour
 * the engine has, and until this block it was the least covered: unit tests reached it
 * with hand-built graphs and the real corpus reached it by accident, but **no fixture
 * could produce it**. `MINIMUM_ROOT_RELATIVE` is 10 and no tree came close, so the
 * layer that runs the whole pipeline over a real directory could not see the feature
 * at all.
 *
 * ⚠️ **The threshold was not lowered to fix that, and lowering it is the wrong repair**
 * — it is a product judgement about when a diagnosis is trustworthy, and fitting it to
 * the corpus is letting the corpus decide the product. `eleventy` gained seven more
 * root-relative references instead, which is what a real Eleventy site looks like: it
 * serves `src/img` at `/img` through `addPassthroughCopy`, so everything is addressed
 * from the site root and nothing name-based should ever detect `src` as a serving root.
 *
 * **The corpus splits the predicate in half, which is why the pair below matters more
 * than either half alone.** `next-app` has the count (10 root-relative references) and
 * a perfect rate; `eleventy` has the rate (0.00) and, before this, failed the count.
 * Only both conditions together fire the guard, so a fixture that satisfies one and not
 * the other proves the conjunction is real rather than decorative.
 */
describe('R58: the serving-root diagnosis, reached through a real tree', () => {
  /**
   * The tree as a **first run** sees it: the serving root detected, never declared.
   *
   * Every other fixture test hands the resolver the right answer out of `PUBLIC_DIRS`,
   * which is the configuration a user arrives at *after* reading a report. This is the
   * state they are in before that, and it is the only state in which this diagnosis
   * can happen — so a helper that declared the root could not reach the feature.
   */
  async function undetected(name: (typeof NAMES)[number]) {
    const { discovered, references, unscanned } = await scan(name);
    const servingRoots = detectServingRoots(discovered.directories);
    const resolved = await resolveReferences(references, {
      root: discovered.root,
      assets: discovered.assets,
      servingRoots,
      excludedRoots: discovered.excludedRoots,
      exists: (path) => existsSync(path),
    });
    const graph = buildGraph({
      root: discovered.root,
      assets: discovered.assets,
      references: resolved,
      unscannedFiles: [...discovered.unscannedFiles, ...unscanned],
    });
    const readFile: ReadFilePort = (path) => readFile_(path, 'utf8');

    return {
      servingRoots,
      health: resolutionHealth(graph),
      result: await audit({
        graph,
        sweep: await sweepForMentions({ graph, readFile }),
        readFile,
        publicDirs: servingRoots.dirs,
      }),
    };
  }

  it('finds no serving root in the eleventy tree at all', async () => {
    // The premise the rest of this block stands on. `src` is a source directory, not a
    // serving root by convention, so a name-based detector must not claim it — and if
    // one ever did, every assertion below would go green for the wrong reason.
    expect((await undetected('eleventy')).servingRoots).toEqual({ dirs: [], declared: false });
  });

  it('fires the guard on a real tree, through the whole pipeline', async () => {
    const { health } = await undetected('eleventy');

    // ⚠️ Asserted as a RELATIONSHIP to the constant, never as the literal 10. The
    // fixture sits at exactly the minimum on purpose — no padding, so the threshold is
    // crossed naturally rather than by references added to pass a test — but pinning
    // the literal here would make this fail the first time somebody legitimately adds a
    // reference to this tree, and a test that cries wolf teaches people to edit the
    // assertion. The boundary itself is pinned where it belongs, in
    // `resolution-health.test.ts`, at the minimum and one below it.
    expect(health.checkable).toBeGreaterThanOrEqual(MINIMUM_ROOT_RELATIVE);
    expect(health.linked).toBe(0);
    expect(health.servingRootUnknown).toBe(true);
  });

  it('reports one diagnosis instead of every root-relative symptom', async () => {
    const { result } = await undetected('eleventy');
    const diagnoses = result.findings.filter((finding) => finding.kind === 'serving-root-unknown');

    expect(diagnoses).toHaveLength(1);
    const [diagnosis] = diagnoses;
    if (diagnosis?.kind !== 'serving-root-unknown') throw new Error('unreachable');
    // Every root-relative reference in the tree, and nothing else: the count the user
    // reads has to agree with the findings that were taken away, which is the defect
    // the public-dir caveat had when it claimed 950 against 903 listed.
    expect(diagnosis.suppressedBroken).toBe(diagnosis.checkable);
    expect(diagnosis.linked).toBe(0);
  });

  it('suppresses only what it explains, and the relative break survives', async () => {
    // 🔴 **The whole reason R58 named a relative reference as part of the fixture.** The
    // first version of `diagnoseServingRoot` swallowed all 116 broken findings on
    // unconfigured shadcn-ui when only 115 were root-relative, and the odd one out was a
    // genuinely broken relative path — a real defect hidden behind an unrelated
    // explanation. That shape was only ever reachable on a real repository, and only
    // ever found by a person reading a report. It is reachable here now.
    const { result } = await undetected('eleventy');
    const broken = result.findings.filter((finding) => finding.kind === 'broken');

    expect(broken.map((finding) => finding.kind === 'broken' && finding.rawPath)).toEqual([
      '../img/missing-on-purpose.png',
    ]);
  });

  it.each(NAMES.filter((name) => name !== 'eleventy'))(
    'does not fire on %s, which resolves its root-relative references',
    async (name) => {
      // The other direction, and it is not padding: a diagnosis that fired everywhere
      // would pass all four assertions above while suppressing every real finding in
      // the corpus. `next-app` is the one that matters most here — it reaches the count
      // with a perfect rate, so it is the fixture that proves the guard reads both
      // conditions rather than the count alone.
      const { health } = await undetected(name);

      expect(health.servingRootUnknown).toBe(false);
    },
  );

  it('is healthy again once the same tree declares its serving root', async () => {
    // The diagnosis is about our knowledge, not about the user's code. Nothing on disk
    // changes between this and the run above — only whether `src` was declared — so a
    // guard that stayed lit here would be calling a correctly configured project broken.
    const { discovered, references, unscanned } = await scan('eleventy');
    const resolved = await resolveReferences(references, {
      root: discovered.root,
      assets: discovered.assets,
      servingRoots: { declared: true, dirs: [PUBLIC_DIRS.eleventy] },
      excludedRoots: discovered.excludedRoots,
      exists: (path) => existsSync(path),
    });
    const health = resolutionHealth(
      buildGraph({
        root: discovered.root,
        assets: discovered.assets,
        references: resolved,
        unscannedFiles: [...discovered.unscannedFiles, ...unscanned],
      }),
    );

    expect(health.checkable).toBeGreaterThanOrEqual(MINIMUM_ROOT_RELATIVE);
    expect(health.rate).toBe(1);
    expect(health.servingRootUnknown).toBe(false);
  });
});
