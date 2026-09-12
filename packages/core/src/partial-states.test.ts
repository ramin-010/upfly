import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defaultAdapters } from './adapters/default-adapters.js';
import { discover } from './discover.js';
import { buildGraph } from './graph.js';
import { type PublicPolicy, patternTargets, planOptimization } from './plan.js';
import { createSharpProbe } from './probe-sharp.js';
import { probeAssets } from './probe.js';
import { resolveReferences } from './resolve.js';
import { scanSources } from './scan.js';

/**
 * R67 — the partial-failure fixture, and why this file exists at all.
 *
 * 🔴 **Three times this phase, a fix's triggering condition could not be produced by
 * the corpus.** R58's low-resolution guard was unreachable from any fixture. R61's
 * figure did not move on a single repository. R65's sibling withdrawal could not fire,
 * because every pattern decline on `scratch-www` is all-or-nothing. After three, that
 * is structural rather than bad luck.
 *
 * **The cause is worth naming.** The corpus is five *real* repositories, and a real
 * repository is either working or misconfigured — it is almost never **half working**.
 * Partial states are half a monorepo's roots detected, a pattern where two of three
 * siblings convert, a tree sitting just under the resolution floor. None of those
 * occur naturally, so no amount of adding real repositories produces one.
 *
 * ⚠️ **So a fix whose triggering condition the corpus cannot produce gets a hand-built
 * fixture, and that is not a second-class test.** `fixtures/eleventy` already proved
 * the point: R58's guard now fires through the real pipeline instead of only against a
 * hand-assembled graph. This does the same for the planner.
 *
 * **Everything below runs the real pipeline and a real sharp probe.** Nothing is
 * stubbed — `theme-dark.png` fails to convert because 70 bytes of PNG genuinely
 * measure 94 as WebP, which is the same property `IMAGE-CREDITS.md` records as the
 * reason the fixtures stopped being placeholders. The partial state is a fact about
 * the bytes on disk, not an arrangement of test doubles.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/partial-pattern');

/** The serving root this tree declares. `public/` is served; `src/` is bundled. */
const SERVING_ROOTS = { declared: true, dirs: ['public'] } as const;

async function planFor(publicPolicy: PublicPolicy) {
  const discovered = await discover({ root: ROOT, adapters: defaultAdapters });
  const scanned = await scanSources({
    sourceFiles: discovered.sourceFiles,
    adapters: defaultAdapters,
    readFile: (path) => readFile(path, 'utf8'),
  });
  const references = await resolveReferences(scanned.references, {
    root: discovered.root,
    assets: discovered.assets,
    servingRoots: SERVING_ROOTS,
    excludedRoots: discovered.excludedRoots,
    exists: (path) => existsSync(path),
  });
  const graph = buildGraph({
    root: discovered.root,
    assets: discovered.assets,
    references,
    unscannedFiles: [...discovered.unscannedFiles, ...scanned.unscanned],
  });

  // The real encoder, not a table of numbers. Which sibling blocks the pattern is
  // then a measurement rather than a decision this test made about itself.
  const probe = await createSharpProbe();
  const probes = await probeAssets(discovered.assets, { probe, formats: ['webp'] });

  return {
    graph,
    probes,
    plan: planOptimization({
      graph,
      probes,
      format: 'webp',
      publicDir: 'public',
      publicPolicy,
      hedged: new Set(),
      servingRoots: SERVING_ROOTS,
    }),
  };
}

describe('R67: a partial-failure state, built by hand because no real repository has one', () => {
  describe('the premise, which every assertion below depends on', () => {
    it('resolves one reference to three separate assets', async () => {
      // If this ever became two references, or resolved to one asset, the withdrawal
      // below would stop being a *partial* failure and the fixture would quietly stop
      // testing what it exists to test — while still passing.
      const { graph } = await planFor('replace');

      expect(patternTargets(graph).map((path) => path.split(/[\\/]/).pop())).toEqual([
        'theme-dark.png',
        'theme-light.png',
        'theme-sepia.png',
      ]);
    });

    it('has exactly one sibling that genuinely does not convert, measured', async () => {
      // 🔴 The fixture's whole load-bearing fact, and it is a real encode. 70 bytes of
      // PNG come back as 94 bytes of WebP, so `theme-dark` blocks the pattern because
      // of what it *is*, not because a test said so.
      //
      // ⚠️ **Each asset is compared to its OWN source size**, and the first version of
      // this test was not: it hardcoded 70 for `theme-dark` and infinity for everything
      // else, which meant that swapping `theme-dark` for a convertible photo left it
      // **green** while the three tests below went red. Caught by mutating the fixture,
      // which is the only mutation that could have caught it — the same lesson as R65's
      // blocker sort, arriving a third time. A premise test that cannot see its own
      // premise change is worse than no premise test, because it reads as the guard.
      const { graph, probes } = await planFor('keep-original');
      const sourceBytes = new Map(
        graph.assets.map((node) => [node.asset.relative, node.asset.bytes]),
      );

      const grew = probes.filter((entry) => {
        const webp = entry.encoded.find((size) => size.format === 'webp');
        const source = sourceBytes.get(entry.relative);
        // ⚠️ Throws rather than defaulting. A `?? 0` here is what hid the first
        // version's defect a second time: every WebP is larger than zero, so a lookup
        // that missed reported the whole tree as growing and the assertion failed for
        // a reason that had nothing to do with the fixture.
        if (source === undefined) throw new Error(`no source size for ${entry.relative}`);
        return webp !== undefined && webp.bytes >= source;
      });

      expect(grew.map((entry) => entry.relative)).toEqual(['public/theme-dark.png']);
    });
  });

  describe('R65: the withdrawal fires on a real tree for the first time', () => {
    it('withdraws both converting siblings and says why for each', async () => {
      // Under `replace` the originals go, so a pattern can only be rewritten if all
      // three convert. One decline takes the other two with it — and until R65 those
      // two vanished from the plan with nothing said about them anywhere.
      const { plan } = await planFor('replace');
      const withdrawn = plan.declined.filter((entry) =>
        entry.reason.includes('shares a pattern reference with it'),
      );

      expect(withdrawn.map((entry) => entry.path)).toEqual([
        'public/theme-light.png',
        'public/theme-sepia.png',
      ]);
      for (const entry of withdrawn) {
        // Naming the blocker is the actionable half: fix one file and three convert.
        expect(entry.reason).toContain('public/theme-dark.png');
      }
    });

    it('accounts for all three targets, with none left over', async () => {
      // Stated as arithmetic rather than as a spot check. An asset in neither list is
      // the defect R65 fixed, and this goes red the moment one reappears there.
      const { plan } = await planFor('replace');
      const converted = plan.conversions.map((conversion) => conversion.asset);
      const declined = plan.declined.map((entry) => entry.path);

      for (const target of ['theme-dark', 'theme-light', 'theme-sepia']) {
        const asset = `public/${target}.png`;
        expect([...converted, ...declined], `${asset} is in neither list`).toContain(asset);
      }
      expect(converted).not.toContain('public/theme-light.png');
    });

    it('leaves the ordinary reference beside it untouched', async () => {
      // The control. A withdrawal that took the whole plan with it would satisfy every
      // assertion above and be catastrophically wrong.
      const { plan } = await planFor('replace');

      expect(plan.conversions.map((conversion) => conversion.asset)).toContain('public/banner.png');
      expect(plan.rewrites.map((rewrite) => rewrite.file)).toEqual(['src/App.jsx']);
    });

    it('converts both siblings under keep-original, where nothing is withdrawn', async () => {
      // The same tree, the same measurements, the opposite policy. The originals
      // survive, so the pattern keeps resolving and only the rewrite is declined —
      // which is what makes the withdrawal above a consequence of `replace` rather
      // than of anything about these files.
      const { plan } = await planFor('keep-original');

      expect(plan.conversions.map((conversion) => conversion.asset)).toEqual([
        'public/banner.png',
        'public/theme-light.png',
        'public/theme-sepia.png',
        'src/inline-logo.jpg',
      ]);
      expect(plan.declined.some((entry) => entry.reason.includes('shares a pattern'))).toBe(false);
    });
  });

  describe('R66: the kept original, on a real tree', () => {
    it('keeps and reports the original of an asset outside the served directory', async () => {
      // 🔴 This is `scratch-www`'s 374 creates and 373 deletes at fixture scale. The
      // behaviour is correct — `src/` is bundler-managed, so a reference we failed to
      // rewrite would break the build rather than show a missing image — and what was
      // wrong was that nothing said so.
      const { plan } = await planFor('replace');

      expect(plan.keptOriginals.map((kept) => kept.asset)).toEqual(['src/inline-logo.jpg']);
      expect(plan.keptOriginals[0]?.reason).toContain('break the build');
    });

    it('removes the original of a served asset, which is the other half', async () => {
      // Without this the fixture would pass just as well against a planner that had
      // simply stopped replacing anything.
      const { plan } = await planFor('replace');
      const banner = plan.conversions.find(
        (conversion) => conversion.asset === 'public/banner.png',
      );

      expect(banner?.replacesOriginal).toBe(true);
    });

    it('never files a kept original as declined, which would deny it converted', async () => {
      // The lists are disjoint by construction: the report renders `declined` under
      // "Examined and not converted", and this asset was converted.
      const { plan } = await planFor('replace');

      expect(plan.conversions.map((conversion) => conversion.asset)).toContain(
        'src/inline-logo.jpg',
      );
      expect(plan.declined.map((entry) => entry.path)).not.toContain('src/inline-logo.jpg');
    });

    it('reports no kept originals under keep-original, where every original stays', async () => {
      // Saying it for all four would bury the one case that means something.
      expect((await planFor('keep-original')).plan.keptOriginals).toEqual([]);
    });
  });
});
