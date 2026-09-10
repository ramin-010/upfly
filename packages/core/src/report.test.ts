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
  });

  const graph = buildGraph({
    root: discovery.root,
    assets: discovery.assets,
    references: resolveReferences(scanned.references, {
      root: discovery.root,
      assets: discovery.assets,
      publicDir: PUBLIC_DIRS[name] ?? 'public',
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
    publicDir: PUBLIC_DIRS[name] ?? 'public',
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

    it('names the flag that actually produces the list', () => {
      // Pointing a user at `--json` gave them a bare integer. A message that sends
      // someone where the data is not costs more trust than no message would.
      const text = renderReport(reportOf(false));

      expect(text).toContain('1 path-shaped string was not an asset reference');
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
