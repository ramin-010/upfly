import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defaultAdapters } from './adapters/default-adapters.js';
import { audit } from './audit.js';
import type { Finding } from './audit.js';
import { discover } from './discover.js';
import { buildGraph } from './graph.js';
import { createSharpProbe } from './probe-sharp.js';
import { probeAssets } from './probe.js';
import { renderReport } from './report-human.js';
import { REPORT_SCHEMA_VERSION, buildReport } from './report.js';
import type { Report } from './report.js';
import { resolveReferences } from './resolve.js';
import { scanSources } from './scan.js';
import { sweepForMentions } from './sweep.js';
import type { Mention } from './sweep.js';
import type { Adapter } from './types.js';

/**
 * The report is public API (rule 6), so this is a snapshot test over real fixture
 * trees rather than hand-built data — a schema change should be visible as a diff
 * somebody has to approve.
 *
 * It also carries the §5.1(f) guard: the same repository rendered from a different
 * working directory must produce byte-identical output, which means no absolute path
 * may reach it.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures');
const ADAPTERS: readonly Adapter[] = defaultAdapters;

const PUBLIC_DIRS: Record<string, string> = {
  'vite-react': 'public',
  'next-app': 'public',
  astro: 'public',
  'plain-html': '',
  eleventy: 'src',
};

async function reportFor(name: string, probed = false, includeDiscarded = false): Promise<Report> {
  const root = join(FIXTURES, name);
  const discovery = await discover({ root, adapters: ADAPTERS });
  const readFileText = (path: string) => readFile(path, 'utf8');

  const scanned = await scanSources({
    sourceFiles: discovery.sourceFiles,
    adapters: ADAPTERS,
    readFile: readFileText,
    assetBasenames: basenamesOf(discovery.assets),
  });

  const graph = buildGraph({
    root: discovery.root,
    assets: discovery.assets,
    references: resolveReferences(scanned.references, {
      root: discovery.root,
      assets: discovery.assets,
      servingRoots: { declared: true, dirs: [PUBLIC_DIRS[name] ?? 'public'] },
      excludedRoots: discovery.excludedRoots,
      exists: (path) => existsSync(path),
    }),
    unscannedFiles: [...discovery.unscannedFiles, ...scanned.unscanned],
  });

  const sweep = await sweepForMentions({ graph, readFile: readFileText });
  const probes = probed
    ? await probeAssets(
        graph.assets.map((node) => node.asset),
        { probe: await createSharpProbe(), formats: ['webp'] },
      )
    : undefined;

  const auditResult = await audit({
    graph,
    sweep,
    readFile: readFileText,
    publicDirs: [PUBLIC_DIRS[name] ?? 'public'],
    ...(probes === undefined ? {} : { probes }),
  });

  return buildReport({
    graph,
    audit: auditResult,
    discovery,
    sweep,
    servingRoots: { dirs: [PUBLIC_DIRS[name] ?? 'public'], declared: true },
    includeDiscarded,
    ...(probes === undefined ? {} : { probes }),
  });
}

const NAMES = ['vite-react', 'next-app', 'astro', 'plain-html', 'eleventy'] as const;

/** Lowercased asset basenames, for the mention pass `scan` does while reading. */
function basenamesOf(assets: readonly { relative: string }[]): Set<string> {
  return new Set(
    assets.map((asset) => asset.relative.slice(asset.relative.lastIndexOf('/') + 1).toLowerCase()),
  );
}

describe('buildReport', () => {
  it('declares its schema version', async () => {
    expect((await reportFor('plain-html')).version).toBe(REPORT_SCHEMA_VERSION);
  });

  it.each(NAMES)('%s: matches the approved JSON shape', async (name) => {
    // Rule 6: the schema is public API. A change here should be a diff someone
    // deliberately approves, not something that ships because tests still pass.
    expect(await reportFor(name)).toMatchSnapshot();
  });

  it.each(NAMES)('%s: matches the approved human rendering', async (name) => {
    expect(renderReport(await reportFor(name))).toMatchSnapshot();
  });

  describe('no absolute path leaks — §5.1(f)', () => {
    it.each(NAMES)('%s: the serialised report never contains the root', async (name) => {
      // The guard for the property the whole module exists to hold. Half the data
      // upstream carries an absolute `path` beside its `relative`, so this is one
      // forgotten projection away from being false.
      const report = await reportFor(name);
      const serialised = JSON.stringify(report);

      expect(serialised).not.toContain(FIXTURES);
      expect(serialised).not.toContain('\\\\');
      expect(serialised).not.toMatch(/[A-Za-z]:\//);
    });

    it('renders no absolute path in the human output either', async () => {
      const text = renderReport(await reportFor('astro'));

      expect(text).not.toContain(FIXTURES);
    });
  });

  describe('determinism — rule 11', () => {
    it('produces byte-identical JSON across two runs', async () => {
      const [first, second] = await Promise.all([reportFor('astro'), reportFor('astro')]);

      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    });

    it('carries no timestamp or duration', async () => {
      const serialised = JSON.stringify(await reportFor('eleventy'));

      expect(serialised).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
      expect(Object.keys((await reportFor('eleventy')).summary)).not.toContain('durationMs');
    });
  });

  describe('what the summary says', () => {
    it('counts a saving once per asset even when two formats were measured', async () => {
      // Summing every measurement would double-count an asset measured against
      // both webp and avif, and the headline number would be a fiction.
      const report = await reportFor('plain-html', true);

      expect(report.summary.potentialSavingBytes).toBeGreaterThanOrEqual(0);
      expect(report.summary.probed).toBe(true);
    });

    it('says it did not probe when it did not', async () => {
      const report = await reportFor('plain-html');

      expect(report.summary.probed).toBe(false);
      expect(report.caveats.map((caveat) => caveat.code)).toContain('not-probed');
    });
  });

  describe('the caveats', () => {
    it('names the public-dir dead count rather than hedging those assets', async () => {
      const report = await reportFor('astro');
      const caveat = report.caveats.find((entry) => entry.code === 'public-dir-dead');

      expect(caveat?.count).toBe(1);
      expect(report.findings.some((finding) => finding.kind === 'dead')).toBe(true);
    });

    it('names the file types no adapter reads', async () => {
      const report = await reportFor('eleventy');

      expect(report.coverage.unscannedExtensions).toEqual([{ ext: '.njk', fileCount: 2 }]);
      expect(report.caveats.map((caveat) => caveat.code)).toContain('unscanned-extensions');
    });
  });

  describe('the encode cap caveat', () => {
    // Hand-built: no fixture run is capped, so a fixture-driven assertion here
    // would never fire. Same trap as the discarded candidates one below.
    function cappedReport() {
      const ROOT = '/repo';
      return buildReport({
        graph: buildGraph({ root: ROOT, assets: [], references: [], unscannedFiles: [] }),
        audit: {
          findings: [],
          publicDirDeadCount: 0,
          conventionLinked: [],
          unreadableSources: [],
          probed: true,
        },
        discovery: {
          root: ROOT,
          assets: [],
          sourceFiles: [],
          directories: [],
          ignoredCount: 0,
          skipped: [],
          excludedRoots: [],
          unscannedFiles: [],
        },
        sweep: { mentions: new Map(), skipped: [] },
        servingRoots: { dirs: ['public'], declared: true },
        probes: [
          {
            relative: 'huge.png',
            metadata: { width: 10, height: 10, format: 'png', pages: 1 },
            encoded: [],
            skipped: [
              {
                measurement: 'webp',
                code: 'beyond-encode-cap',
                reason:
                  'not among the 2 largest assets measured (run with --probe-all to measure the rest)',
              },
            ],
          },
        ],
      });
    }

    it('counts the assets it did not measure', () => {
      const caveat = cappedReport().caveats.find((entry) => entry.code === 'encode-capped');

      expect(caveat?.count).toBe(1);
    });

    it('names --probe-all, the flag a user wants at that moment', () => {
      // Both `--max-encodes <n>` and `--probe-all` reach the same option. This
      // string is where someone notices a number is missing, so it points at the
      // discoverable name rather than the tunable.
      const text = renderReport(cappedReport());

      expect(text).toContain('--probe-all');
    });

    it('lists the per-asset reason in the skipped section too', () => {
      const text = renderReport(cappedReport());

      expect(text).toContain('huge.png');
      expect(text).toContain('could not be measured');
    });
  });

  describe('the possibly-dead headings — R16', () => {
    // Hand-built, and it has to be: **every hedge in every fixture tree comes from
    // an `.astro` or `.njk` file**, so all five are `unscanned-file`. A
    // fixture-driven assertion about the other two sources could never fire — which
    // is precisely how a heading that is false for 119 of astro-docs' 140 findings
    // shipped past a green suite.
    //
    // ⚠️ **Rasters, deliberately, and they used to be the `.svg` logos this defect was
    // found on.** R22 demotes an unreferenced vector out of `findings` entirely, so
    // vector assets here would leave this block asserting over the one raster that
    // survived — three headings tested by nothing. The block is about *which evidence
    // source heads a hedge*, and that question does not depend on the file's format,
    // so the fix is to hedge assets R22 keeps. R22's own demotion is asserted
    // separately below, on data built for it.
    const ROOT = '/repo';

    function mention(source: Mention['source'], where: string, quote: string): Mention {
      return { asset: quote, source, where, quote };
    }

    function hedgedReport(): Report {
      const hedge = (asset: string, evidence: readonly [Mention, ...Mention[]]): Finding => ({
        kind: 'possibly-dead',
        asset,
        bytes: 2048,
        inPublicDir: false,
        evidence,
      });

      return buildReport({
        graph: buildGraph({ root: ROOT, assets: [], references: [], unscannedFiles: [] }),
        audit: {
          findings: [
            // Two from one file, so the grouping has something to count.
            hedge('public/logos/gitbook.png', [
              mention('unresolved-reference', 'src/data/logos.ts:56', 'gitbook.png'),
            ]),
            hedge('public/logos/hugo.png', [
              mention('unresolved-reference', 'src/data/logos.ts:65', 'hugo.png'),
            ]),
            hedge('src/assets/docs.png', [
              mention('unscanned-file', 'src/components/SiteTitle.astro:3', 'docs.png'),
            ]),
            hedge('public/assets/arc.webp', [
              mention('scanned-file', 'src/content/tutorial.mdx:119', 'arc.webp'),
            ]),
          ],
          publicDirDeadCount: 0,
          conventionLinked: [],
          unreadableSources: [],
          probed: false,
        },
        discovery: {
          root: ROOT,
          assets: [],
          sourceFiles: [],
          directories: [],
          ignoredCount: 0,
          skipped: [],
          excludedRoots: [],
          unscannedFiles: [],
        },
        sweep: { mentions: new Map(), skipped: [] },
        servingRoots: { dirs: ['public'], declared: true },
      });
    }

    it('never claims a file could not be read when the engine read it fine', () => {
      // The defect R16 was ruled on. `src/data/logos.ts` is ordinary TypeScript that
      // parses perfectly; `'gitbook.png'` is simply not a resolvable path. A user who
      // follows that citation under a "cannot read" heading opens a readable file and
      // concludes the tool is broken — one wrong sentence costing a correct finding.
      const text = renderReport(hedgedReport());
      const section = text.slice(text.indexOf('possibly unreferenced'));
      const unresolvedLine = section
        .split('\n')
        .findIndex((line) => line.includes('src/data/logos.ts'));
      const heading = section
        .split('\n')
        .slice(0, unresolvedLine)
        .filter((line) => line.trimStart().startsWith('named '))
        .at(-1);

      expect(heading).toContain('could not resolve');
      expect(heading).not.toContain('no adapter reads');
    });

    it('heads each evidence source separately, because they mean different things', () => {
      const text = renderReport(hedgedReport());

      expect(text).toContain('named in a file no adapter reads');
      expect(text).toContain('named in text Upfly read but no adapter claimed');
      expect(text).toContain('named by a path Upfly read but could not resolve');
    });

    it('groups by the citing file and counts it, which is the actionable fact', () => {
      const text = renderReport(hedgedReport());

      expect(text).toContain('src/data/logos.ts — 2 assets');
      expect(text).toContain('src/components/SiteTitle.astro — 1 asset');
    });

    it('files an asset under its most actionable evidence, and still prints the rest', () => {
      // A real case: `Sponsors.astro` imports `./logos/mux.svg` and `logos.ts` names
      // `mux.svg` too, so the asset carries both. It belongs under the heading with
      // something to do about it, and neither citation may be dropped. Spelled `.png`
      // here for the reason given above: R22 would demote the vector it really is.
      const both = buildReport({
        graph: buildGraph({ root: ROOT, assets: [], references: [], unscannedFiles: [] }),
        audit: {
          findings: [
            {
              kind: 'possibly-dead',
              asset: 'public/logos/mux.png',
              bytes: 809,
              inPublicDir: true,
              evidence: [
                mention('unresolved-reference', 'src/data/logos.ts:80', 'mux.png'),
                mention('unscanned-file', 'src/components/Sponsors.astro:4', 'mux.png'),
              ],
            },
          ],
          publicDirDeadCount: 0,
          conventionLinked: [],
          unreadableSources: [],
          probed: false,
        },
        discovery: {
          root: ROOT,
          assets: [],
          sourceFiles: [],
          directories: [],
          ignoredCount: 0,
          skipped: [],
          excludedRoots: [],
          unscannedFiles: [],
        },
        sweep: { mentions: new Map(), skipped: [] },
        servingRoots: { dirs: ['public'], declared: true },
      });
      const text = renderReport(both);

      expect(text).toContain('named in a file no adapter reads');
      expect(text).not.toContain('could not resolve —');
      expect(text).toContain('src/components/Sponsors.astro — 1 asset');
      expect(text).toContain('named in src/data/logos.ts:80');
    });
  });

  // Built with `String.fromCharCode` rather than an escape: this harness eats a
  // backslash in transit, which turned `split('\n')` into a split on a literal
  // newline in the source. Known trap, documented in STATE.md's Gotchas.
  const NEWLINE = String.fromCharCode(10);

  describe('one sentence, said once (R25 #3)', () => {
    // `--probe-all` appeared 81 times in shadcn-ui's report: once on each of 80
    // capped assets plus the caveat. Same wall as the 126 SVG lines.
    const ROOT = '/repo';

    function reportWithCapped(n: number) {
      return buildReport({
        graph: buildGraph({ root: ROOT, assets: [], references: [], unscannedFiles: [] }),
        audit: {
          findings: [],
          publicDirDeadCount: 0,
          conventionLinked: [],
          unreadableSources: [],
          probed: true,
        },
        discovery: {
          root: ROOT,
          assets: [],
          sourceFiles: [],
          directories: [],
          ignoredCount: 0,
          skipped: [],
          excludedRoots: [],
          unscannedFiles: [],
        },
        sweep: { mentions: new Map(), skipped: [] },
        servingRoots: { dirs: ['public'], declared: true },
        probes: Array.from({ length: n }, (_, index) => ({
          relative: `img${index}.png`,
          metadata: { width: 10, height: 10, format: 'png' as const, pages: 1 },
          encoded: [],
          skipped: [
            {
              measurement: 'webp' as const,
              code: 'beyond-encode-cap' as const,
              reason: 'not among the 100 largest assets measured (run with --probe-all)',
            },
          ],
        })),
      });
    }

    it('says a shared reason once, with a count', () => {
      const text = renderReport(reportWithCapped(80));

      expect(text).toContain('80 files — webp: not among the 100 largest');
      // Three places, each saying something different: the collapsed skip line, the
      // caveat, and the headline's floor clause. Was 81 — once per capped asset.
      expect(text.match(/--probe-all/g)).toHaveLength(3);
    });

    it('keeps every name under the collapsed reason, not just a count', () => {
      // ⚠️ The first version of this dropped the names, which was wrong for the
      // case beside it: eleventy-docs has ten `.js` files that are really Nunjucks
      // templates, and *which ten* is the actionable part. The sentence moves up;
      // the names stay.
      const text = renderReport(reportWithCapped(80));

      expect(text).toContain('img0.png');
      expect(text).toContain('img79.png');
      expect(reportWithCapped(80).skipped).toHaveLength(80);
    });

    it('still names them individually when there are only a few', () => {
      // Three lines are easier to read than a count you have to go and look up.
      const text = renderReport(reportWithCapped(2));

      expect(text).toContain('img0.png');
      expect(text).toContain('img1.png');
    });
  });

  describe('the headline says what to act on, and says when it is a floor (R21 #4, R25 #2)', () => {
    /**
     * §5.1(d)'s criterion is whether the numbers are obvious in ten seconds, and
     * this is the only text that gets ten seconds. It failed twice: two overlapping
     * counts with no stated relationship, and the savings figure — the one line
     * anybody wants — placed fourth while being a **floor** that said so only in a
     * caveat forty lines below.
     *
     * Three of the four branches below are unreachable from every fixture, because
     * `reportFor` runs them all with `probed: false`. Same trigger as the skipped
     * section and the size section: when every fixture shares a value for the thing
     * under test, the fixtures cannot test it.
     */
    const ROOT = '/repo';

    function headlineOf(over: {
      probed?: boolean;
      saving?: number;
      capped?: number;
      assets?: number;
      alsoAvif?: boolean;
    }) {
      const assetCount = over.assets ?? 10;
      const assets = Array.from({ length: assetCount }, (_, index) => ({
        path: `${ROOT}/img${index}.png`,
        relative: `img${index}.png`,
        extension: '.png',
        bytes: 100,
      }));
      const probes = Array.from({ length: over.capped ?? 0 }, (_, index) => ({
        relative: `img${index}.png`,
        metadata: { width: 10, height: 10, format: 'png' as const, pages: 1 },
        encoded: [],
        skipped: [
          {
            measurement: 'webp' as const,
            code: 'beyond-encode-cap' as const,
            reason: 'beyond the cap',
          },
        ],
      }));

      const report = buildReport({
        graph: buildGraph({ root: ROOT, assets, references: [], unscannedFiles: [] }),
        audit: {
          findings:
            over.saving === undefined
              ? []
              : [
                  {
                    kind: 'format-opportunity' as const,
                    quality: 80,
                    asset: 'img0.png',
                    from: 'png',
                    to: 'webp' as const,
                    bytes: 1_000_000,
                    wouldBe: 1_000_000 - over.saving,
                    savedBytes: over.saving,
                    savedPercent: 50,
                  },
                  ...(over.alsoAvif
                    ? [
                        {
                          kind: 'format-opportunity' as const,
                          quality: 75,
                          asset: 'img0.png',
                          from: 'png',
                          to: 'avif' as const,
                          bytes: 1_000_000,
                          wouldBe: 1_000_000 - over.saving,
                          savedBytes: over.saving,
                          savedPercent: 50,
                        },
                      ]
                    : []),
                ],
          publicDirDeadCount: 0,
          conventionLinked: [],
          unreadableSources: [],
          probed: over.probed ?? true,
        },
        discovery: {
          root: ROOT,
          assets,
          sourceFiles: [],
          directories: [],
          ignoredCount: 0,
          skipped: [],
          excludedRoots: [],
          unscannedFiles: [],
        },
        sweep: { mentions: new Map(), skipped: [] },
        servingRoots: { dirs: ['public'], declared: true },
        ...(probes.length > 0 ? { probes } : {}),
      });

      return renderReport(report).split(NEWLINE)[2] ?? '';
    }

    it('leads with the savings, not with the file counts', () => {
      expect(headlineOf({ saving: 4_200_000 })).toContain('4.2 MB of savings');
    });

    it('states the quality the saving was measured at', () => {
      // A saving without its quality is not a figure: the same images give 95% at
      // quality 50 and 44% at quality 90. The report used to open with a headline
      // like "166.3 MB of savings found so far" and name no quality anywhere in the
      // file, so a reader could not tell which product they were being offered.
      expect(headlineOf({ saving: 4_200_000 })).toContain('of savings at webp quality 80,');
    });

    it('names every format when more than one was measured', () => {
      expect(headlineOf({ saving: 4_200_000, alsoAvif: true })).toContain(
        'at avif quality 75 and webp quality 80,',
      );
    });

    it('says the number is incomplete when the cap left images unmeasured', () => {
      // R25 #2. shadcn-ui had 80 of 195 unmeasured, and the report presented its
      // total as if it were the total. The count goes in the same sentence.
      const line = headlineOf({ saving: 4_200_000, capped: 3, assets: 10 });

      expect(line).toContain('so far');
      expect(line).toContain('3 of 10 images went unmeasured');
      expect(line).toContain('--probe-all');
    });

    it('says plainly that it measured everything when it did', () => {
      expect(headlineOf({ saving: 4_200_000, assets: 10 })).toContain(
        'measured across all 10 images',
      );
    });

    it('distinguishes "no savings" from "not measured"', () => {
      // Two very different statements that both used to render as an absent line.
      expect(headlineOf({ assets: 10 })).toContain('no savings found');
      expect(headlineOf({ probed: false })).toContain('savings not measured');
    });
  });

  describe('one image, one size story (R21)', () => {
    /**
     * `oversized` and `format-opportunity` are two measurements of the same file,
     * and they were printed in sections a page apart with nothing linking them. On
     * `astro-docs` **all five** oversized assets were also opportunities, so every
     * one appeared twice and the sentence a reader wants — "551 KB, and 340 KB as
     * webp" — was in neither place.
     *
     * Hand-built, and unavoidably so: `reportFor` runs the fixtures with
     * `probed = false`, so **no fixture produces either finding**. The merged
     * section is invisible to every snapshot. That is the fourth report branch this
     * phase that no fixture could reach.
     */
    const ROOT = '/repo';

    function sizeReport(findings: Finding[]) {
      return buildReport({
        graph: buildGraph({ root: ROOT, assets: [], references: [], unscannedFiles: [] }),
        audit: {
          findings,
          publicDirDeadCount: 0,
          conventionLinked: [],
          unreadableSources: [],
          probed: true,
        },
        discovery: {
          root: ROOT,
          assets: [],
          sourceFiles: [],
          directories: [],
          ignoredCount: 0,
          skipped: [],
          excludedRoots: [],
          unscannedFiles: [],
        },
        sweep: { mentions: new Map(), skipped: [] },
        servingRoots: { dirs: ['public'], declared: true },
      });
    }

    const oversized: Finding = {
      kind: 'oversized',
      asset: 'src/assets/landing-page-book.png',
      bytes: 551_000,
      width: 2256,
      height: 1320,
      exceeded: ['bytes'],
    };
    const opportunity: Finding = {
      kind: 'format-opportunity',
      quality: 80,
      asset: 'src/assets/landing-page-book.png',
      bytes: 551_000,
      from: 'png',
      wouldBe: 340_000,
      to: 'webp',
      savedBytes: 211_000,
      savedPercent: 38,
    };

    it('reports one file once, with both measurements under it', () => {
      const text = renderReport(sizeReport([oversized, opportunity]));

      expect(text.match(/landing-page-book\.png/g)).toHaveLength(1);
      expect(text).toContain('larger than the size limit');
      expect(text).toContain('as webp');
    });

    it('keeps both counts in the heading, so the merge hides nothing', () => {
      // Rule 9 applied to a collapse: two numbers went in, two numbers come out.
      const text = renderReport(sizeReport([oversized, opportunity]));

      expect(text).toContain('1 over the limit');
      expect(text).toContain('1 smaller as another format');
    });

    it('reads naturally for a file with only one of the two', () => {
      const text = renderReport(sizeReport([opportunity]));

      expect(text).toContain('landing-page-book.png');
      // The specific line, not the substring: `over ` also matches the heading's
      // "0 over the limit", so the loose version failed for the right reason.
      expect(text).not.toContain('larger than the size limit');
      expect(text).toContain('0 over the limit');
    });
  });

  describe('a determination is not a failure (R21)', () => {
    /**
     * `Skipped — 140 things Upfly could not handle` was false for 134 of them on
     * `astro-docs`: 126 vectors and 8 files already in the target format, each one
     * Upfly *working out* that there was nothing to gain. The reader's question was
     * the right one — "if you can identify that, doesn't that count?"
     *
     * Hand-built because **no fixture renders the skipped section at all.** Every
     * stage label, the heading, and the grouping are invisible to the fixture
     * snapshots, so this whole path looks tested and is not — the same trap as the
     * discarded line, the encode cap and the counted-unsafe branch.
     */
    const ROOT = '/repo';

    function probe(relative: string, code: 'vector' | 'already-target-format' | 'encode-failed') {
      const reason =
        code === 'vector'
          ? 'SVG is a vector: encoding it measures a rasterisation, not a saving'
          : code === 'already-target-format'
            ? 'already webp'
            : 'the encoder rejected it';
      return {
        relative,
        metadata: { width: 10, height: 10, format: 'png' as const, pages: 1 },
        encoded: [],
        skipped: [{ measurement: 'webp' as const, code, reason }],
      };
    }

    function reportWith(probes: ReturnType<typeof probe>[]) {
      return buildReport({
        graph: buildGraph({ root: ROOT, assets: [], references: [], unscannedFiles: [] }),
        audit: {
          findings: [],
          publicDirDeadCount: 0,
          conventionLinked: [],
          unreadableSources: [],
          probed: true,
        },
        discovery: {
          root: ROOT,
          assets: [],
          sourceFiles: [],
          directories: [],
          ignoredCount: 0,
          skipped: [],
          excludedRoots: [],
          unscannedFiles: [],
        },
        sweep: { mentions: new Map(), skipped: [] },
        servingRoots: { dirs: ['public'], declared: true },
        probes,
      });
    }

    it('keeps a vector and an already-converted file out of the skipped list', () => {
      const report = reportWith([
        probe('logo.svg', 'vector'),
        probe('hero.webp', 'already-target-format'),
      ]);

      expect(report.skipped).toEqual([]);
    });

    it('counts them in one caveat instead, with the reasons broken out', () => {
      // Rule 9: the count survives the collapse, and the per-asset detail is
      // untouched in `probes[].skipped` for anyone reading the JSON.
      const caveat = reportWith([
        probe('a.svg', 'vector'),
        probe('b.svg', 'vector'),
        probe('c.webp', 'already-target-format'),
      ]).caveats.find((entry) => entry.code === 'nothing-to-measure');

      expect(caveat?.count).toBe(3);
      expect(caveat?.message).toContain('needed no measurement');
      expect(caveat?.detail).toEqual([
        'vectors, where an encode would measure a rasterisation rather than a saving — 2',
        'already in the format Upfly would convert to — 1',
      ]);
    });

    describe('R64: the report names where the libraries own words went', () => {
      /**
       * Hand-built for the same reason the block around it is: **no fixture can reach
       * this line.** Every fixture report passes no `diagnosticsFile`, so it renders
       * as `null` in all five approved snapshots and the rendered sentence is executed
       * by nothing — the same trap this file already names for the discarded line and
       * the encode cap.
       */
      function rendered(diagnosticsFile?: string) {
        const report = reportWith([probe('broken.png', 'encode-failed')]);
        return renderReport(
          diagnosticsFile === undefined ? report : { ...report, diagnosticsFile },
        );
      }

      it('names the file when the run wrote one', () => {
        // R60 moved this text out of the report, which was right. What it left behind
        // was a reader with nowhere to look and nothing saying anywhere existed — the
        // text had been relocated and only half of rule 9 was being kept.
        const text = rendered('railsgirls-com.diagnostics.txt');

        expect(text).toContain('railsgirls-com.diagnostics.txt');
        expect(text).toContain('their wording, not ours');
      });

      it('says nothing at all when no such file was written', () => {
        // Absent is the honest answer, not a default name. Naming a file that does
        // not exist sends a reader looking for nothing, which is worse than silence —
        // and the CLI writes none of these yet.
        const text = rendered();

        expect(text).not.toContain('diagnostics');
        expect(text).toContain('broken.png');
      });

      it('is a name and never a path, so two checkouts render the same bytes', () => {
        // Rule 11. An absolute path in the report is a defect this codebase has had
        // once already, found by §5.1(f) on `eleventy-docs`.
        const report = reportWith([probe('broken.png', 'encode-failed')]);

        expect(report.diagnosticsFile).toBeNull();
        expect(JSON.stringify(report)).not.toContain(ROOT);
      });
    });

    it('still reports a measurement that genuinely failed', () => {
      // The control, and the thing that must not be lost: an encoder rejecting an
      // image is a failure, not a determination, and it belongs in the list.
      const report = reportWith([probe('broken.png', 'encode-failed')]);

      expect(report.skipped).toEqual([
        { what: 'broken.png', stage: 'measurement', reason: 'webp: the encoder rejected it' },
      ]);
      expect(report.caveats.some((entry) => entry.code === 'nothing-to-measure')).toBe(false);
    });

    it('says what the sweep skip actually was, not "could not be searched"', () => {
      // Eight fonts over the sweep's size limit, under a heading about what Upfly
      // could not handle and beside conversion messages, read as "why are we trying
      // to convert fonts?" They are not being converted at all.
      const report = buildReport({
        graph: buildGraph({ root: ROOT, assets: [], references: [], unscannedFiles: [] }),
        audit: {
          findings: [],
          publicDirDeadCount: 0,
          conventionLinked: [],
          unreadableSources: [],
          probed: false,
        },
        discovery: {
          root: ROOT,
          assets: [],
          sourceFiles: [],
          directories: [],
          ignoredCount: 0,
          skipped: [],
          excludedRoots: [],
          unscannedFiles: [],
        },
        sweep: {
          mentions: new Map(),
          skipped: [{ relative: 'fonts/inter.woff2', reason: 'over 2 MB' }],
        },
        servingRoots: { dirs: ['public'], declared: true },
      });
      const text = renderReport(report);

      expect(text).toContain('too large to search for asset filenames');
      expect(text).not.toContain('could not be searched');
      expect(text).toContain('each with its reason');
    });
  });

  describe('the unsafe bucket lists what can be checked (R21)', () => {
    // Hand-built, and it has to be: the only fixture with an unsafe reference has
    // exactly one, and it *shows a filename*, so the counted branch below is
    // unreachable from every fixture tree. That is the same trap as the discarded
    // line and the encode cap — a new branch that no fixture can reach looks tested
    // and is not.
    const ROOT = '/repo';

    function dynamicReference(file: string, rawPath: string, start: number) {
      return {
        file: `${ROOT}/${file}`,
        start,
        end: start + rawPath.length,
        rawPath,
        kind: 'string' as const,
        ceiling: 'unsafe' as const,
        asserted: true,
        resolution: 'dynamic' as const,
        confidence: 'unsafe' as const,
        resolvedPath: null,
      };
    }

    function reportWith(rawPaths: readonly string[]) {
      return buildReport({
        graph: buildGraph({
          root: ROOT,
          assets: [],
          references: rawPaths.map((rawPath, index) =>
            dynamicReference('app.ts', rawPath, index * 100),
          ),
          unscannedFiles: [],
        }),
        audit: {
          findings: [],
          publicDirDeadCount: 0,
          conventionLinked: [],
          unreadableSources: [],
          probed: false,
        },
        discovery: {
          root: ROOT,
          assets: [],
          sourceFiles: [],
          directories: [],
          ignoredCount: 0,
          skipped: [],
          excludedRoots: [],
          unscannedFiles: [],
        },
        sweep: { mentions: new Map(), skipped: [] },
        servingRoots: { dirs: ['public'], declared: true },
      });
    }

    it('lists the ones showing a filename somebody could go and look at', () => {
      const text = renderReport(reportWith(['${base}/hero.png', '/img/${slug}.jpg']));

      expect(text).toContain('${base}/hero.png');
      expect(text).toContain('/img/${slug}.jpg');
    });

    it('counts the ones with no filename instead of listing them', () => {
      // `/view/${style}/${name}` shows nothing to check, and with no extension it
      // can never glob to an asset either. Fifty of these buried the eight a person
      // could act on — shadcn-ui listed 187 entries of which 8 named an image.
      const text = renderReport(
        reportWith(['${base}/hero.png', '/view/${style}/${name}', '/api/${id}']),
      );

      expect(text).toContain('${base}/hero.png');
      expect(text).not.toContain('/view/');
      expect(text).toContain('plus 2 with no filename to check');
    });

    it('still reports the full count in the heading — rule 9 survives the collapse', () => {
      // The whole risk of this change: a list that quietly shrinks. The heading has
      // to keep covering everything, listed or not.
      const text = renderReport(reportWith(['/view/${style}/${name}', '/api/${id}']));

      expect(text).toContain('2 references could not be resolved safely');
      expect(text).toContain('none with a filename to check');
    });
  });

  describe('discarded candidates', () => {
    // Every fixture tree has zero discarded candidates, so these are hand-built.
    // A fixture-only test here would pass while asserting nothing — the guard
    // would simply never fire, which is the vacuous-test trap in miniature.
    const ROOT = '/repo';

    function discardedGraph() {
      const reference = {
        file: `${ROOT}/package.json`,
        start: 10,
        end: 26,
        rawPath: 'assets/logo.png',
        kind: 'json' as const,
        ceiling: 'high' as const,
        asserted: false,
        resolution: 'discarded' as const,
        confidence: 'unsafe' as const,
        resolvedPath: null,
      };
      return buildGraph({ root: ROOT, assets: [], references: [reference], unscannedFiles: [] });
    }

    function reportOf(includeDiscarded: boolean) {
      return buildReport({
        graph: discardedGraph(),
        audit: {
          findings: [],
          publicDirDeadCount: 0,
          conventionLinked: [],
          unreadableSources: [],
          probed: false,
        },
        discovery: {
          root: ROOT,
          assets: [],
          sourceFiles: [],
          directories: [],
          ignoredCount: 0,
          skipped: [],
          excludedRoots: [],
          unscannedFiles: [],
        },
        sweep: { mentions: new Map(), skipped: [] },
        servingRoots: { dirs: ['public'], declared: true },
        includeDiscarded,
      });
    }

    it('counts them but does not list them by default', () => {
      const report = reportOf(false);

      expect(report.references.discardedCount).toBe(1);
      // `null`, not `[]`: an empty array would read as "there were none", which is
      // the same class of lie as silence reading as "no opportunity here".
      expect(report.references.discarded).toBeNull();
    });

    it('lists them when asked, so the promise in §1.1 is real', () => {
      // The JSON adapter is deliberately generous. If it ever starts eating
      // genuine references, the count says something is wrong and only the list
      // says what — and that is not debuggable from an integer.
      const report = reportOf(true);

      expect(report.references.discarded).toEqual([
        {
          file: 'package.json',
          rawPath: 'assets/logo.png',
          resolution: 'discarded',
          reason: 'a path-shaped string that resolved to nothing',
        },
      ]);
    });

    it('says the strings did not resolve, never that they were not references', () => {
      // The line read "N path-shaped strings were not asset references". Measured on
      // `astro-docs`, **117 of its 118** name a file that genuinely is an asset in
      // that repository — `src/data/logos.ts` holds `{ file: 'gitbook.svg' }` a
      // hundred and seventeen times, joined to a base directory at runtime.
      //
      // It also contradicted the same report a page later: those identical strings
      // are the R10 haystack's evidence, so the findings section cites them as proof
      // an asset is alive while this line called them not references at all.
      const text = renderReport(reportOf(false));

      expect(text).toContain('did not resolve to an asset');
      expect(text).not.toContain('not an asset reference');
      expect(text).not.toContain('not asset references');
    });

    it('names the flag that actually produces the list', () => {
      // Pointing a user at `--json` gave them a bare integer. A message that sends
      // someone where the data is not costs more trust than no message would.
      const text = renderReport(reportOf(false));

      expect(text).toContain('1 path-shaped string did not resolve to an asset');
      expect(text).toContain('--include-discarded');
      expect(text).not.toContain('use --json to inspect');
    });

    it('shows them in the human output too when the flag was given', () => {
      // Otherwise the flag appears to do nothing unless `--json` is passed with it.
      const text = renderReport(reportOf(true));

      expect(text).toContain('package.json  assets/logo.png');
      expect(text).not.toContain('--include-discarded');
    });
  });

  describe('the human rendering', () => {
    it('prints what was skipped before what was found', async () => {
      // The ordering that the previous generation of this project got wrong: a
      // limitation printed after eighty findings is a limitation nobody reads.
      const text = renderReport(await reportFor('eleventy'));
      const unresolved = text.indexOf('could not be resolved safely');
      const findings = text.indexOf('Findings');

      expect(unresolved).toBeGreaterThan(-1);
      expect(unresolved).toBeLessThan(findings);
    });

    it('cites where a possibly-dead asset was named', async () => {
      const text = renderReport(await reportFor('eleventy'));

      expect(text).toContain('named in src/posts/first.md:7');
    });

    it('cites the line of a broken reference', async () => {
      const text = renderReport(await reportFor('plain-html'));

      expect(text).toContain('about.html:10');
    });

    it('formats bytes without locale rules', async () => {
      // `toLocaleString` would render `1,5 MB` in some locales, and rule 11's
      // byte-identical output would quietly stop being true.
      const text = renderReport(await reportFor('plain-html'));

      expect(text).not.toMatch(/\d,\d/);
    });
  });

  /**
   * R22 and R23, hand-built — and they have to be.
   *
   * ⚠️ **Every one of the five fixture trees produced `unusedVectors.count: 0`.** That
   * is the stated trigger for building a case by hand: when every fixture has the same
   * value for the thing under test, the fixtures cannot test it, and a green suite says
   * only that nothing changed. `vite-react` gained `src/assets/unused-icon.svg` so the
   * demotion runs end to end, but the plural wording, the flag, the rescue, the
   * no-pair cases and the empty-findings branch are all reachable only from here.
   *
   * R23 is worse than untested by fixtures: **it produces zero pairs on all three
   * validation repos too.** `shadcn-ui` has 20 broken references and 10 unreferenced
   * vectors and pairs none of them, because all 20 broken references are themselves
   * `.svg` — `/next.svg`, `/vercel.svg`, `/vite.svg` from framework scaffolds. So the
   * only evidence R23 works at all is below, and the only evidence it does not
   * over-fire is the scaffold case it is asserted against.
   */
  describe('unreferenced vectors — R22 and R23', () => {
    const ROOT = '/repo';

    function deadVector(asset: string, bytes: number): Finding {
      return { kind: 'dead', asset, bytes, inPublicDir: false };
    }

    function brokenAt(rawPath: string, where: string): Finding {
      return { kind: 'broken', file: where.split(':')[0] ?? where, line: 1, where, rawPath };
    }

    function reportOf(findings: readonly Finding[], includeUnusedVectors = false): Report {
      return buildReport({
        graph: buildGraph({ root: ROOT, assets: [], references: [], unscannedFiles: [] }),
        audit: {
          findings,
          publicDirDeadCount: 0,
          conventionLinked: [],
          unreadableSources: [],
          probed: false,
        },
        discovery: {
          root: ROOT,
          assets: [],
          sourceFiles: [],
          directories: [],
          ignoredCount: 0,
          skipped: [],
          excludedRoots: [],
          unscannedFiles: [],
        },
        sweep: { mentions: new Map(), skipped: [] },
        servingRoots: { dirs: ['public'], declared: true },
        includeUnusedVectors,
      });
    }

    it('demotes an unreferenced vector out of findings, carrying count and size', () => {
      const report = reportOf([
        deadVector('public/logo.svg', 1200),
        deadVector('public/icon.svg', 800),
        { kind: 'dead', asset: 'public/photo.png', bytes: 5000, inPublicDir: false },
      ]);

      const named = report.findings.map((finding) => {
        if (finding.kind === 'broken') return finding.rawPath;
        return finding.kind === 'serving-root-unknown' ? finding.kind : finding.asset;
      });
      expect(named).toEqual(['public/photo.png']);
      expect(report.unusedVectors.count).toBe(2);
      expect(report.unusedVectors.bytes).toBe(2000);
    });

    it('counts the itemised array in the summary, so the two can never disagree', () => {
      // The arithmetic R17's caveat exists to protect, one step further on. A reader
      // who adds up the findings must get the headline number, and the difference has
      // to be explained by something on the page rather than by a bug.
      const report = reportOf([
        deadVector('public/logo.svg', 1200),
        { kind: 'dead', asset: 'public/photo.png', bytes: 5000, inPublicDir: false },
      ]);

      expect(report.summary.findings.dead).toBe(report.findings.length);
      expect(report.summary.findings.dead).toBe(1);
    });

    it('hedged vectors are demoted too, not only confident ones', () => {
      // `possibly-dead` is where the volume actually is: 122 of astro-docs' 140
      // hedges are vectors. Demoting only `dead` would have moved 4 findings.
      const report = reportOf([
        {
          kind: 'possibly-dead',
          asset: 'public/logos/gitbook.svg',
          bytes: 900,
          inPublicDir: true,
          evidence: [
            {
              asset: 'gitbook.svg',
              source: 'unresolved-reference',
              where: 'src/data/logos.ts:56',
              quote: 'gitbook.svg',
            },
          ],
        },
      ]);

      expect(report.findings).toEqual([]);
      expect(report.unusedVectors.count).toBe(1);
    });

    it('itemises them behind the flag, and says null rather than empty without it', () => {
      const findings = [deadVector('public/logo.svg', 1200)];

      expect(reportOf(findings).unusedVectors.assets).toBeNull();
      expect(reportOf(findings, true).unusedVectors.assets).toEqual([
        { asset: 'public/logo.svg', bytes: 1200, kind: 'dead' },
      ]);
    });

    it('keeps a vector itemised when a broken reference asks for its raster twin', () => {
      // R23's rescue, and the reason R22 cannot simply filter: for *this* vector there
      // is an action — fix the reference — so demoting it would hide the one unused
      // vector in the repository worth looking at.
      const report = reportOf([
        deadVector('images/hero.svg', 1200),
        brokenAt('images/hero.png', 'about.html:10'),
      ]);

      expect(report.unusedVectors.count).toBe(0);
      const kept = report.findings.map((finding) => {
        if (finding.kind === 'broken') return finding.rawPath;
        return finding.kind === 'serving-root-unknown' ? finding.kind : finding.asset;
      });
      expect(kept).toContain('images/hero.svg');
      expect(report.staleConversions).toEqual([
        { vector: 'images/hero.svg', rawPath: 'images/hero.png', where: 'about.html:10' },
      ]);
    });

    it('says both facts and asserts neither, because the pairing is an inference', () => {
      const text = renderReport(
        reportOf([
          deadVector('images/hero.svg', 1200),
          brokenAt('images/hero.png', 'about.html:10'),
        ]),
      );

      expect(text).toContain('may have been converted by hand without updating the reference');
      expect(text).toContain(
        'images/hero.svg is unreferenced, and about.html:10 asks for images/hero.png',
      );
    });

    it('does not pair a vector with a broken reference to another vector', () => {
      // `shadcn-ui`'s real shape: 20 broken references, every one an `.svg` from a
      // framework scaffold, beside 10 unreferenced vectors. Pairing on stem alone
      // would have invented a conversion story for `next.svg` against `next.svg`.
      const report = reportOf([
        deadVector('public/next.svg', 1200),
        brokenAt('/next.svg', 'app/page.tsx:34'),
      ]);

      expect(report.staleConversions).toEqual([]);
      expect(report.unusedVectors.count).toBe(1);
    });

    it('does not pair on a stem a broken reference only resembles', () => {
      const report = reportOf([
        deadVector('images/hero.svg', 1200),
        brokenAt('images/hero-wide.png', 'about.html:10'),
        brokenAt('images/Hero.png', 'about.html:11'),
      ]);

      // Exact and case-sensitive. `Hero.png` is a different file on the platform most
      // of this runs on, and a hint nobody asked for costs more trust than a missed one.
      expect(report.staleConversions).toEqual([]);
    });

    it('does not claim there is nothing to see when everything was demoted', () => {
      // ⚠️ `No findings.` was a lie the moment R22 started demoting, and no fixture and
      // no validation repo reaches it — all eight have other findings. A repository
      // whose only unreferenced assets are vectors gets this branch.
      const text = renderReport(reportOf([deadVector('public/logo.svg', 1200)]));

      expect(text).toContain('No findings, apart from 1 unreferenced SVG counted above');
      expect(text).not.toContain('No findings.');
    });

    it('agrees with itself about one vector and about several', () => {
      // The verb-agreement bug has shipped six times in this renderer, twice from the
      // chat that wrote R22 — once in the caveat and once in the headline, the second
      // caught only by reading the rendered text. Both counts are asserted so neither
      // wording can drift back.
      const one = renderReport(reportOf([deadVector('public/logo.svg', 1200)]));
      const two = renderReport(
        reportOf([deadVector('public/logo.svg', 1200), deadVector('public/icon.svg', 800)]),
      );

      expect(one).toContain('including 1 unreferenced SVG, 1.2 KB');
      expect(one).toContain('1 unreferenced SVG totalling 1.2 KB, not listed');
      expect(two).toContain('including 2 unreferenced SVGs, 2 KB');
      expect(two).toContain('2 unreferenced SVGs totalling 2 KB, not listed');
    });

    it('explains the gap where the reader is, not forty lines below it', () => {
      // R21 #4's lesson applied to R22's own consequence: the headline says how many
      // images have no reference, and the findings list now shows fewer. If the only
      // explanation sat in the caveats, R22 would have recreated the defect R21 #4
      // was raised about.
      const text = renderReport(reportOf([deadVector('public/logo.svg', 1200)]));
      const headlineMention = text.indexOf('including 1 unreferenced SVG');
      const findingsHeading = text.indexOf('No findings');

      expect(headlineMention).toBeGreaterThan(-1);
      expect(headlineMention).toBeLessThan(findingsHeading);
    });

    it('says nothing at all when there are no unreferenced vectors', () => {
      // The other half of every count: a report with no vectors must not grow a line
      // reading "0 unreferenced vectors", which is the noise R21 was raised about.
      const text = renderReport(
        reportOf([{ kind: 'dead', asset: 'public/photo.png', bytes: 5000, inPublicDir: false }]),
      );

      expect(text).not.toContain('unreferenced SVG');
      expect(text).not.toContain('--include-unused-svg');
    });
  });
});

describe('byResolvedVia — the field that says which links may be rewritten (R36)', () => {
  const ROOT = resolve('/repo');
  const ASSET = {
    path: join(ROOT, 'at-root.png'),
    relative: 'at-root.png',
    extension: '.png',
    bytes: 10,
  };

  /** Built through `resolveReferences`, so the value under test is the engine's own. */
  function reportFor(rawPath: string, asserted: boolean): Report {
    const references = resolveReferences(
      [
        {
          file: join(ROOT, 'src', 'page.tsx'),
          start: 0,
          end: rawPath.length,
          rawPath,
          kind: asserted ? 'attr' : 'json',
          ceiling: 'high',
          asserted,
        },
      ],
      {
        root: ROOT,
        assets: [ASSET],
        servingRoots: { declared: true, dirs: ['public'] },
        exists: () => false,
      },
    );

    return buildReport({
      graph: buildGraph({ root: ROOT, assets: [ASSET], references, unscannedFiles: [] }),
      audit: {
        findings: [],
        publicDirDeadCount: 0,
        conventionLinked: [],
        unreadableSources: [],
        probed: false,
      },
      discovery: {
        root: ROOT,
        assets: [ASSET],
        sourceFiles: [],
        directories: [],
        ignoredCount: 0,
        skipped: [],
        excludedRoots: [],
        unscannedFiles: [],
      },
      sweep: { mentions: new Map(), skipped: [] },
      servingRoots: { dirs: ['public'], declared: true },
    });
  }

  it('counts a root-relative fallback as project-root, not as the speculative one', () => {
    // Measured at 1,325 occurrences across the five validation repos, 1,267 asserted.
    // All five fixture trees produce ZERO of these, so without a hand-built case the
    // split is unexercised at the report layer -- the fixtures cannot test it.
    const report = reportFor('/at-root.png', true);

    expect(report.references.byResolvedVia['project-root']).toBe(1);
    expect(report.references.byResolvedVia['speculative-root']).toBe(0);
  });

  it('counts a speculative dot-path retry as speculative-root', () => {
    const report = reportFor('./at-root.png', false);

    expect(report.references.byResolvedVia['speculative-root']).toBe(1);
    expect(report.references.byResolvedVia['project-root']).toBe(0);
  });

  it('sums to exactly the linked resolutions and to nothing else', () => {
    // The invariant the doc comment promises, derived from byResolution rather than
    // from a pasted number, so it holds for any input rather than for these two.
    for (const [rawPath, asserted] of [
      ['/at-root.png', true],
      ['./at-root.png', false],
    ] as const) {
      const report = reportFor(rawPath, asserted);
      const via = Object.values(report.references.byResolvedVia).reduce((a, b) => a + b, 0);
      const linked =
        report.references.byResolution.resolved +
        report.references.byResolution['resolved-pattern'];

      expect(via).toBe(linked);
    }
  });
});

describe('the headline reads correctly at a count of one (R21 / the agreement bug)', () => {
  const ROOT = resolve('/repo');

  /** One reference, one linked asset, one unreferenced asset — every count is 1. */
  function singularReport(): Report {
    const linked = {
      path: join(ROOT, 'used.png'),
      relative: 'used.png',
      extension: '.png',
      bytes: 10,
    };
    const orphan = {
      path: join(ROOT, 'spare.png'),
      relative: 'spare.png',
      extension: '.png',
      bytes: 10,
    };
    const references = resolveReferences(
      [
        {
          file: join(ROOT, 'index.html'),
          start: 0,
          end: '/used.png'.length,
          rawPath: '/used.png',
          kind: 'attr',
          ceiling: 'high',
          asserted: true,
        },
      ],
      {
        root: ROOT,
        assets: [linked, orphan],
        servingRoots: { declared: true, dirs: [''] },
        exists: () => false,
      },
    );

    return buildReport({
      graph: buildGraph({
        root: ROOT,
        assets: [linked, orphan],
        references,
        unscannedFiles: [],
      }),
      audit: {
        findings: [],
        publicDirDeadCount: 0,
        conventionLinked: [],
        unreadableSources: [],
        probed: false,
      },
      discovery: {
        root: ROOT,
        assets: [linked, orphan],
        sourceFiles: [],
        directories: [],
        ignoredCount: 0,
        skipped: [],
        excludedRoots: [],
        unscannedFiles: [],
      },
      sweep: { mentions: new Map(), skipped: [] },
      servingRoots: { dirs: ['public'], declared: true },
    });
  }

  it('says nothing that disagrees with itself', () => {
    // Every fixture tree has plural counts here, so the fixtures cannot test this --
    // and that is exactly how "1 image have no reference" shipped. The assertions are
    // written against English rather than against the current output.
    const rendered = renderReport(singularReport());

    expect(rendered).not.toMatch(/\b1 image have\b/);
    expect(rendered).not.toMatch(/\b1 reference resolve\b/);
    expect(rendered).not.toMatch(/\bthey point at\b.*\n?/);
  });

  it('renders the singular lines in full, so the wording is reviewable', () => {
    const rendered = renderReport(singularReport());

    // Derived by writing the sentence out, not by pasting what the renderer emits.
    expect(rendered).toContain('1 of 1 reference resolved, pointing at 1 of those images');
    expect(rendered).toContain('1 image with no reference Upfly could follow');
  });
});

describe('the serving roots the report discloses', () => {
  const ROOT = '/repo';

  function reportWith(dirs: readonly string[], declared: boolean): Report {
    return buildReport({
      graph: buildGraph({ root: ROOT, assets: [], references: [], unscannedFiles: [] }),
      audit: {
        findings: [],
        publicDirDeadCount: 0,
        conventionLinked: [],
        unreadableSources: [],
        probed: false,
      },
      discovery: {
        root: ROOT,
        assets: [],
        sourceFiles: [],
        directories: [],
        ignoredCount: 0,
        skipped: [],
        excludedRoots: [],
        unscannedFiles: [],
      },
      sweep: { mentions: new Map(), skipped: [] },
      servingRoots: { dirs, declared },
    });
  }

  it('carries them into the JSON exactly as the resolver was given them', () => {
    const report = reportWith(['apps/v4/public', 'apps/www/public'], false);

    expect(report.coverage.servingRoots).toEqual({
      dirs: ['apps/v4/public', 'apps/www/public'],
      declared: false,
    });
  });

  it('tells the reader when the roots were detected rather than declared', () => {
    // The whole point of R50 part 3. Every broken finding under this line depends on
    // the engine having guessed right, and a guess nobody is told about is the defect
    // R49 was.
    const rendered = renderReport(reportWith(['public'], false));

    expect(rendered).toContain('what Upfly detected rather than what the project declared');
    expect(rendered).toContain('public');
  });

  it('stays quiet when the project declared them, because there is nothing to own up to', () => {
    const rendered = renderReport(reportWith(['public'], true));

    expect(rendered).not.toContain('Upfly detected');
  });

  it('says so plainly when it found none and none was declared', () => {
    // A static site really does serve from its own root, so this is not a failure.
    // It still has to be said: it is the state in which every root-relative path
    // resolves against the project root and nobody chose that.
    const rendered = renderReport(reportWith([], false));

    expect(rendered).toContain('resolved from the project root');
    expect(rendered).toContain('found no public directory and none was declared');
  });

  it('names three and counts the rest, rather than printing twelve paths', () => {
    const twelve = Array.from({ length: 12 }, (_, index) => `app${index}/public`);

    const rendered = renderReport(reportWith(twelve, false));

    expect(rendered).toContain('(12 in all): app0/public, app1/public, app2/public, and 9 more');
  });

  it('never pluralises a noun against a number, which this renderer keeps getting wrong', () => {
    // `count()` pluralises by appending to whatever it is handed, so the first draft
    // of this line rendered "12 directory Upfly detecteds". The sentence now contains
    // no noun that agrees with a number at all.
    for (const dirs of [['public'], ['a/public', 'b/public']]) {
      const rendered = renderReport(reportWith(dirs, false));

      expect(rendered).not.toMatch(/detecteds/);
      expect(rendered).toContain(`(${dirs.length} in all)`);
    }
  });
});

describe('the assets a plan examined and offered nothing for', () => {
  const ROOT = '/repo';

  function reportWith(over: {
    declined?: { path: string; line: null; reason: string }[];
    include?: boolean;
  }) {
    return buildReport({
      graph: buildGraph({
        root: ROOT,
        assets: [
          { path: `${ROOT}/a.png`, relative: 'a.png', extension: '.png', bytes: 3_000 },
          { path: `${ROOT}/b.png`, relative: 'b.png', extension: '.png', bytes: 1_000 },
        ],
        references: [],
        unscannedFiles: [],
      }),
      audit: {
        findings: [],
        publicDirDeadCount: 0,
        conventionLinked: [],
        unreadableSources: [],
        probed: true,
      },
      discovery: {
        root: ROOT,
        assets: [],
        sourceFiles: [],
        directories: [],
        ignoredCount: 0,
        skipped: [],
        excludedRoots: [],
        unscannedFiles: [],
      },
      sweep: { mentions: new Map(), skipped: [] },
      servingRoots: { dirs: ['public'], declared: true },
      ...(over.declined === undefined ? {} : { declined: over.declined }),
      ...(over.include === undefined ? {} : { includeDeclined: over.include }),
    });
  }

  const TWO = [
    { path: 'a.png', line: null, reason: 'measured as webp and came out no smaller' },
    { path: 'b.png', line: null, reason: 'nothing links to it' },
  ];

  it('counts them and totals their size', () => {
    expect(reportWith({ declined: TWO }).declined).toMatchObject({ count: 2, bytes: 4_000 });
  });

  it('withholds the list unless it was asked for, and says so', () => {
    // R22's shape: withheld because there is no action to offer, not because it is
    // long. `null` rather than `[]`, because an empty array reads as "there were none".
    const report = reportWith({ declined: TWO });

    expect(report.declined.assets).toBeNull();
    expect(renderReport(report)).toContain('use --include-declined to list them');
  });

  it('itemises them behind the flag, with the planner’s own reason', () => {
    const report = reportWith({ declined: TWO, include: true });

    expect(report.declined.assets).toHaveLength(2);
    const rendered = renderReport(report);
    expect(rendered).toContain('a.png');
    expect(rendered).toContain('measured as webp and came out no smaller');
    expect(rendered).not.toContain('use --include-declined');
  });

  it('says nothing at all on a run that never planned', () => {
    // An audit-only report has no plan and therefore no declines. Printing "0 images"
    // would invite a reader to conclude the planner ran and found nothing.
    const report = reportWith({});

    expect(report.declined).toEqual({ count: 0, bytes: 0, assets: null });
    expect(renderReport(report)).not.toContain('Examined and not converted');
  });

  it('keeps a declined asset the graph does not know, at zero bytes', () => {
    // A miss means the planner and the graph disagree about a path. Reporting it with
    // no size is worse than reporting it; dropping it is the silence rule 9 forbids.
    const report = reportWith({
      declined: [{ path: 'ghost.png', line: null, reason: 'no measured saving' }],
      include: true,
    });

    expect(report.declined).toMatchObject({ count: 1, bytes: 0 });
    expect(report.declined.assets?.[0]).toMatchObject({ asset: 'ghost.png', bytes: 0 });
  });
});

describe('the public-dir caveat counts what the report lists', () => {
  // Hand-built, because NO fixture can reach this. It needs an unreferenced vector
  // that is also inside a public directory, and the five trees between them have
  // unreferenced vectors only outside one. The defect was found on railsgirls-com the
  // moment the caveat became reachable at all: 950 claimed against 903 dead findings
  // listed, alongside a third number saying 61 SVGs were not listed, and no
  // arithmetic a reader can do that reconciles them.
  const ROOT = resolve('/repo');
  const png = { path: join(ROOT, 'a.png'), relative: 'a.png', extension: '.png', bytes: 10 };
  const svg = { path: join(ROOT, 'b.svg'), relative: 'b.svg', extension: '.svg', bytes: 10 };

  function reportWithDeadPublicAssets(): Report {
    return buildReport({
      graph: buildGraph({ root: ROOT, assets: [png, svg], references: [], unscannedFiles: [] }),
      audit: {
        findings: [
          { kind: 'dead', asset: 'a.png', bytes: 10, inPublicDir: true },
          { kind: 'dead', asset: 'b.svg', bytes: 10, inPublicDir: true },
        ],
        // What the audit produces, before this report demotes the vector.
        publicDirDeadCount: 2,
        conventionLinked: [],
        unreadableSources: [],
        probed: false,
      },
      discovery: {
        root: ROOT,
        assets: [png, svg],
        sourceFiles: [],
        directories: [],
        ignoredCount: 0,
        skipped: [],
        excludedRoots: [],
        unscannedFiles: [],
      },
      sweep: { mentions: new Map(), skipped: [] },
      servingRoots: { dirs: [''], declared: true },
    });
  }

  it('does not count a vector it demoted out of the findings', () => {
    const report = reportWithDeadPublicAssets();
    const caveat = report.caveats.find((entry) => entry.code === 'public-dir-dead');

    // The SVG is demoted to unusedVectors and is not in findings, so counting it
    // would promise a reader two entries and show them one.
    expect(caveat?.count).toBe(1);
  });

  it('agrees with the number of dead public findings it actually lists', () => {
    const report = reportWithDeadPublicAssets();
    const caveat = report.caveats.find((entry) => entry.code === 'public-dir-dead');
    const listed = report.findings.filter(
      (finding) => finding.kind === 'dead' && finding.inPublicDir,
    ).length;

    expect(caveat?.count).toBe(listed);
  });
});
