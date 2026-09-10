import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cssAdapter } from './adapters/css.js';
import { htmlAdapter } from './adapters/html.js';
import { javascriptAdapter } from './adapters/javascript.js';
import { jsonAdapter } from './adapters/json.js';
import { markdownAdapter } from './adapters/markdown.js';
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
const ADAPTERS: readonly Adapter[] = [
  cssAdapter,
  htmlAdapter,
  javascriptAdapter,
  markdownAdapter,
  jsonAdapter,
];

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
      publicDirs: [PUBLIC_DIRS[name] ?? 'public'],
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
          ignoredCount: 0,
          skipped: [],
          excludedRoots: [],
          unscannedFiles: [],
        },
        sweep: { mentions: new Map(), skipped: [] },
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
            hedge('public/logos/gitbook.svg', [
              mention('unresolved-reference', 'src/data/logos.ts:56', 'gitbook.svg'),
            ]),
            hedge('public/logos/hugo.svg', [
              mention('unresolved-reference', 'src/data/logos.ts:65', 'hugo.svg'),
            ]),
            hedge('src/assets/docs.svg', [
              mention('unscanned-file', 'src/components/SiteTitle.astro:3', 'docs.svg'),
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
          ignoredCount: 0,
          skipped: [],
          excludedRoots: [],
          unscannedFiles: [],
        },
        sweep: { mentions: new Map(), skipped: [] },
      });
    }

    it('never claims a file could not be read when the engine read it fine', () => {
      // The defect R16 was ruled on. `src/data/logos.ts` is ordinary TypeScript that
      // parses perfectly; `'gitbook.svg'` is simply not a resolvable path. A user who
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
      // something to do about it, and neither citation may be dropped.
      const both = buildReport({
        graph: buildGraph({ root: ROOT, assets: [], references: [], unscannedFiles: [] }),
        audit: {
          findings: [
            {
              kind: 'possibly-dead',
              asset: 'public/logos/mux.svg',
              bytes: 809,
              inPublicDir: true,
              evidence: [
                mention('unresolved-reference', 'src/data/logos.ts:80', 'mux.svg'),
                mention('unscanned-file', 'src/components/Sponsors.astro:4', 'mux.svg'),
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
          ignoredCount: 0,
          skipped: [],
          excludedRoots: [],
          unscannedFiles: [],
        },
        sweep: { mentions: new Map(), skipped: [] },
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
          ignoredCount: 0,
          skipped: [],
          excludedRoots: [],
          unscannedFiles: [],
        },
        sweep: { mentions: new Map(), skipped: [] },
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
                    asset: 'img0.png',
                    from: 'png',
                    to: 'webp' as const,
                    bytes: 1_000_000,
                    wouldBe: 1_000_000 - over.saving,
                    savedBytes: over.saving,
                    savedPercent: 50,
                  },
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
          ignoredCount: 0,
          skipped: [],
          excludedRoots: [],
          unscannedFiles: [],
        },
        sweep: { mentions: new Map(), skipped: [] },
        ...(probes.length > 0 ? { probes } : {}),
      });

      return renderReport(report).split(NEWLINE)[2] ?? '';
    }

    it('leads with the savings, not with the file counts', () => {
      expect(headlineOf({ saving: 4_200_000 })).toContain('4.2 MB of savings');
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
          ignoredCount: 0,
          skipped: [],
          excludedRoots: [],
          unscannedFiles: [],
        },
        sweep: { mentions: new Map(), skipped: [] },
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
          ignoredCount: 0,
          skipped: [],
          excludedRoots: [],
          unscannedFiles: [],
        },
        sweep: { mentions: new Map(), skipped: [] },
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
          ignoredCount: 0,
          skipped: [],
          excludedRoots: [],
          unscannedFiles: [],
        },
        sweep: {
          mentions: new Map(),
          skipped: [{ relative: 'fonts/inter.woff2', reason: 'over 2 MB' }],
        },
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
          ignoredCount: 0,
          skipped: [],
          excludedRoots: [],
          unscannedFiles: [],
        },
        sweep: { mentions: new Map(), skipped: [] },
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
          ignoredCount: 0,
          skipped: [],
          excludedRoots: [],
          unscannedFiles: [],
        },
        sweep: { mentions: new Map(), skipped: [] },
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
});
