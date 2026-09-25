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
    it('resolves one reference to four separate assets', async () => {
      // If this ever became two references, or resolved to one asset, the withdrawal
      // below would stop being a *partial* failure and the fixture would quietly stop
      // testing what it exists to test — while still passing.
      const { graph } = await planFor('replace');

      expect(patternTargets(graph).map((path) => path.split(/[\\/]/).pop())).toEqual([
        'theme-dark.png',
        'theme-light.png',
        'theme-not-an-image.png',
        'theme-sepia.png',
      ]);
    });

    it('🔴 has exactly one sibling that cannot convert, PINNED TO ITS REASON', async () => {
      // 🔴 **R138. This asserts the skip CODE, not merely that a sibling declined, and
      // that distinction is the whole lesson of this fixture's second repair.**
      //
      // The blocker used to be `theme-dark.png`: 70 bytes of PNG that webp 80 turned into
      // 94, so it blocked the pattern because of what it *is*. But that reason depended
      // on ENCODER BEHAVIOUR — the most changeable thing in the system — and R79 had
      // already measured that class as nearly empty (56 combinations, WebP won every
      // one) while keeping this fixture as its last member. **A proof built on the last
      // surviving instance of a class we had already measured as dying.**
      //
      // R131's lossless mode emptied it: the same 1×1 encodes losslessly to 36 bytes, so
      // it converts. And there is no replacement image — across 471 real PNGs, **0
      // defeat both encodes**, because a minimal PNG is ~67 bytes against lossless WebP's
      // ~36-byte floor, and on larger images lossless WebP beats PNG by design.
      //
      // So the blocker is now a file that is not an image at all and can never become
      // one. R129 met three real instances of exactly this shape in the corpus —
      // `rg-lisboa-header.png`, `szrubyist.png`, `rg-nairobi-header.png` — so it is the
      // commonest real cause rather than a contrivance.
      //
      // ⚠️ **Asserting only "one sibling did not convert" would let the next encoder
      // improvement change the CAUSE silently while this test went on passing.** That is
      // the shape this same test was already hardened against once before, and it is why
      // the code is named here rather than the outcome.
      const { probes } = await planFor('keep-original');
      const blocked = probes.filter((entry) =>
        entry.skipped.some((skip) => skip.code === 'not-an-image'),
      );

      expect(blocked.map((entry) => entry.relative)).toEqual(['public/theme-not-an-image.png']);
    });

    it('🔴 keeps theme-dark as the corpus evidence that lossy grows and lossless rescues', async () => {
      // ✅ **R138: the artefact another chat placed deliberately is not discarded, it is
      // promoted.** `theme-dark.png` no longer blocks the pattern, and what it does
      // instead is worth more: it is the one image in this repository demonstrating
      // R131's entire case in a single file — webp 80 GROWS it from 70 bytes to 94,
      // lossless takes it to 36, same file, same run.
      //
      // R129 measured 1,736 images of this shape across 5,857. This is the one that lives
      // in a fixture, and it keeps its history.
      const { graph, probes } = await planFor('keep-original');
      const source = graph.assets.find((node) => node.asset.relative === 'public/theme-dark.png');
      const probe = probes.find((entry) => entry.relative === 'public/theme-dark.png');
      const webp = probe?.encoded.find((size) => size.format === 'webp');

      if (source === undefined || webp === undefined) {
        throw new Error('theme-dark.png must be probed for webp');
      }

      // The setting chosen is lossless, and it beats a source the lossy encode grew.
      expect(webp.quality).toBe('lossless');
      expect(webp.bytes).toBeLessThan(source.asset.bytes);
    });
  });

  describe('the partial pattern on a real tree under replace, where only the template reaches the siblings', () => {
    it('converts none of the siblings the template alone reaches, and says why for each', async () => {
      // The template still asks for `.png`, so no reference would ever ask for a converted
      // sibling: under `replace` each would be a new file beside an original that has to
      // stay. This once asserted a withdrawal, then a conversion with every original
      // kept; both kept a sibling from vanishing silently, and so does this.
      //
      // `theme-dark` would convert losslessly, at 36 bytes against a 70-byte source, and
      // is declined like the others: the rule is about who uses the file, not its size.
      const { plan } = await planFor('replace');
      const byTemplate = plan.declined.filter((entry) =>
        entry.reason.includes('reaches it only through'),
      );

      expect(byTemplate.map((entry) => entry.path)).toEqual([
        'public/theme-dark.png',
        'public/theme-light.png',
        'public/theme-sepia.png',
      ]);
      for (const entry of byTemplate) {
        // Where the reference is and what it says: the line that holds them.
        expect(entry.reason).toContain(
          '`src/App.jsx` reaches it only through `/theme-${mode}.png`',
        );
      }
      expect(plan.keptOriginals.some((kept) => kept.asset.includes('theme-'))).toBe(false);
      expect(plan.declined.some((entry) => entry.reason.includes('shares a pattern'))).toBe(false);
    });

    it('accounts for all four targets, with none left over', async () => {
      // Stated as arithmetic rather than as a spot check. An asset in neither list is
      // the defect R65 fixed, and this goes red the moment one reappears there.
      const { plan, probes } = await planFor('replace');
      const converted = plan.conversions.map((conversion) => conversion.asset);
      const declined = plan.declined.map((entry) => entry.path);
      // 🔴 **The blocker is accounted for by its PROBE SKIP, not by the plan — and that
      // asymmetry is a finding, raised in STATE.md rather than fixed here.**
      //
      // Under the old fixture the blocker was measured and grew, so the planner declined
      // it and it appeared in `declined` with a reason. A blocker that was never measured
      // has no plan entry at all: the plan names `theme-not-an-image.png` as the cause of
      // three withdrawals while giving it no line of its own. It is not SILENT — rule 9
      // holds, because the probe records `not-an-image` and the report prints it — but a
      // reader of the plan alone meets a cause with no entry.
      //
      // ⚠️ The guarantee this test exists for is kept intact: an asset in **neither** the
      // plan's lists **nor** the probe's skips still fails here. What widened is where
      // "accounted for" is allowed to live, and that widening is stated rather than
      // assumed.
      const skipped = probes
        .filter((entry) => entry.skipped.length > 0)
        .map((entry) => entry.relative);

      for (const target of ['theme-dark', 'theme-light', 'theme-not-an-image', 'theme-sepia']) {
        const asset = `public/${target}.png`;
        expect(
          [...converted, ...declined, ...skipped],
          `${asset} is in no list at all — not converted, not declined, not skipped`,
        ).toContain(asset);
      }
      expect(declined).toContain('public/theme-light.png');
    });

    it('leaves the ordinary reference beside it untouched', async () => {
      // The control. A change that took the whole plan with it would satisfy every
      // assertion above and be catastrophically wrong.
      const { plan } = await planFor('replace');

      expect(plan.conversions.map((conversion) => conversion.asset)).toContain('public/banner.png');
      expect(plan.rewrites.map((rewrite) => rewrite.file)).toEqual(['src/App.jsx']);
    });

    it('converts every convertible sibling under keep-original, which replace declines', async () => {
      // The same tree, the same measurements, the opposite policy. Under `keep-original`
      // two files are what the user asked for, so the siblings convert and only the
      // rewrite is declined. Under `replace` only what a moved reference uses converts.
      const { plan } = await planFor('keep-original');
      const replaced = (await planFor('replace')).plan;

      expect(replaced.conversions.map((conversion) => conversion.asset)).toEqual([
        'public/banner.png',
        'public/screenshot.png',
        'src/inline-logo.jpg',
      ]);

      expect(plan.conversions.map((conversion) => conversion.asset)).toEqual([
        'public/banner.png',
        // R131's second demonstration: webp 80 GROWS this 1,912-byte screenshot to
        // 19,426 and lossless takes it to 220. Unlike `theme-dark` its saving clears
        // `minSavingBytes`, so it also reaches the report's `savingQuality`.
        'public/screenshot.png',
        // R138: converts losslessly now, where webp 80 grew it. `theme-not-an-image` is
        // absent because it is not an image and never enters the plan.
        'public/theme-dark.png',
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
      const outside = plan.keptOriginals.filter((kept) => kept.reason.includes('break the build'));

      expect(outside.map((kept) => kept.asset)).toEqual(['src/inline-logo.jpg']);
    });

    it('removes the originals of the served assets whose references all move, which is the other half', async () => {
      // Without this the fixture would pass just as well against a planner that had
      // simply stopped replacing anything — the one fix to R180 that every other
      // assertion here would accept.
      const { plan } = await planFor('replace');

      expect(
        plan.conversions
          .filter((conversion) => conversion.replacesOriginal)
          .map((conversion) => conversion.asset),
      ).toEqual(['public/banner.png', 'public/screenshot.png']);
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
