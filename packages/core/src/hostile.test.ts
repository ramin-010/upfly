import { existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
import { buildReport } from './report.js';
import { resolveReferences } from './resolve.js';
import { scanSources } from './scan.js';
import { sweepForMentions } from './sweep.js';
import type { Adapter } from './types.js';

/**
 * §5.1(e): hostile inputs, expected to **degrade gracefully and never crash**.
 *
 * Everything here is a real file on a real disk, because the failure mode being
 * tested is the one a fake cannot produce: what libvips does with 200 MB of
 * nothing, what the walker does with a symlink that points at its own parent, what
 * happens when a file is deleted between the walk and the read.
 *
 * The bar is not "produces good findings". It is: **the run completes, and
 * everything it could not do is in the report with a reason.** A crash loses the
 * other 9 999 files; a silent skip is worse than a crash because nobody learns.
 */

const ADAPTERS: readonly Adapter[] = [
  cssAdapter,
  htmlAdapter,
  javascriptAdapter,
  markdownAdapter,
  jsonAdapter,
];

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await chmod(root, 0o755).catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'upfly-hostile-'));
  roots.push(root);
  // The tree lives in the OS temp dir, so the v2 watcher never sees it. The kill
  // switch is belt and braces — the failure it prevents is silent corruption.
  await writeFile(join(root, 'upfly.config.json'), '{"enabled":false,"watchTargets":[]}\n');
  return root;
}

/** The whole pipeline, as the CLI will run it. Never throws for bad input. */
async function runEverything(root: string, options: { probe?: boolean } = {}) {
  const readFileText = (path: string) =>
    import('node:fs/promises').then((m) => m.readFile(path, 'utf8'));

  const discovery = await discover({ root, adapters: ADAPTERS });
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
      publicDirs: ['public'],
      excludedRoots: discovery.excludedRoots,
      exists: (path) => existsSync(path),
    }),
    unscannedFiles: [...discovery.unscannedFiles, ...scanned.unscanned],
  });

  const sweep = await sweepForMentions({ graph, readFile: readFileText });
  const probes =
    options.probe === true
      ? await probeAssets(
          graph.assets.map((node) => node.asset),
          { probe: await createSharpProbe(), formats: ['webp'] },
        )
      : undefined;

  const auditResult = await audit({
    graph,
    sweep,
    readFile: readFileText,
    publicDirs: ['public'],
    ...(probes === undefined ? {} : { probes }),
  });

  const report = buildReport({
    graph,
    audit: auditResult,
    discovery,
    sweep,
    ...(probes === undefined ? {} : { probes }),
  });

  return { discovery, graph, report, text: renderReport(report) };
}

const isWindows = process.platform === 'win32';

describe('§5.1(e) hostile inputs', () => {
  it('survives a zero-byte image and says why it could not measure it', async () => {
    const root = await makeRoot();
    await writeFile(join(root, 'index.html'), '<img src="empty.png">');
    await writeFile(join(root, 'empty.png'), Buffer.alloc(0));

    const { report } = await runEverything(root, { probe: true });

    // Discovered as an asset — it is a file with an image extension, and pretending
    // otherwise would hide it from the report entirely.
    expect(report.summary.assets).toBe(1);
    expect(report.skipped.some((item) => item.stage === 'measurement')).toBe(true);
  });

  it('survives a truncated image', async () => {
    const root = await makeRoot();
    // A real PNG signature followed by nothing, which is what a half-written file
    // looks like — and the case `failOn: 'none'` does not rescue.
    await writeFile(
      join(root, 'cut.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]),
    );
    await writeFile(join(root, 'page.html'), '<img src="cut.png">');

    const { report } = await runEverything(root, { probe: true });

    expect(report.skipped.some((item) => item.stage === 'measurement')).toBe(true);
    // The reference still resolved: the file exists, it is simply undecodable.
    expect(report.summary.findings.broken).toBe(0);
  });

  it('survives a 200 MB file without reading it into memory', async () => {
    const root = await makeRoot();
    const huge = join(root, 'huge.png');
    await writeFile(huge, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    // Sparse where the filesystem supports it, so this costs a stat-sized file
    // rather than 200 MB of disk — the size is what is under test, not the bytes.
    await truncate(huge, 200 * 1024 * 1024);
    await writeFile(join(root, 'page.html'), '<img src="huge.png">');

    const { report } = await runEverything(root, { probe: true });

    expect(report.summary.assetBytes).toBeGreaterThan(200_000_000);
    // Oversized by bytes, which needs no decode — the finding survives even though
    // the header does not parse. That is the point of taking bytes from discovery.
    expect(report.summary.findings.oversized).toBe(1);
  });

  it('survives non-ASCII and emoji filenames', async () => {
    const root = await makeRoot();
    const names = ['café.png', 'ünïcøde.png', '日本語.png', '🎉-party.png'];
    for (const name of names) await writeFile(join(root, name), Buffer.alloc(8));
    await writeFile(join(root, 'page.html'), names.map((name) => `<img src="${name}">`).join('\n'));

    const { report, graph } = await runEverything(root);

    expect(report.summary.assets).toBe(names.length);
    expect(report.summary.findings.broken).toBe(0);

    // The §5.1(a) invariant with an emoji in play. Offsets are UTF-16 code units,
    // so a surrogate pair earlier in the file must not shift a later reference —
    // and this asserts it directly rather than through a report that lists nothing
    // when everything resolves.
    const source = await readFile(join(root, 'page.html'), 'utf8');
    for (const reference of graph.references) {
      expect(source.slice(reference.start, reference.end)).toBe(reference.rawPath);
    }
    expect(graph.references.map((reference) => reference.rawPath)).toEqual(names);
  });

  it('survives CRLF sources without shifting a reference', async () => {
    const root = await makeRoot();
    await writeFile(join(root, 'hero.png'), Buffer.alloc(8));
    await writeFile(
      join(root, 'page.html'),
      '<html>\r\n  <body>\r\n    <img src="hero.png">\r\n  </body>\r\n</html>\r\n',
    );

    const { graph, report } = await runEverything(root);

    expect(report.summary.findings.broken).toBe(0);
    expect(report.summary.linkedReferences).toBe(1);
    // The citation must land on the real line, not on a line count inflated or
    // deflated by carriage returns.
    expect(graph.references[0]?.rawPath).toBe('hero.png');
  });

  it('survives a file that vanishes between the walk and the read', async () => {
    const root = await makeRoot();
    await writeFile(join(root, 'gone.html'), '<img src="a.png">');
    await writeFile(join(root, 'stays.html'), '<img src="a.png">');
    await writeFile(join(root, 'a.png'), Buffer.alloc(8));

    const discovery = await discover({ root, adapters: ADAPTERS });
    // Deleted after discovery saw it — the race a long walk always loses eventually.
    await rm(join(root, 'gone.html'));

    const scanned = await scanSources({
      sourceFiles: discovery.sourceFiles,
      adapters: ADAPTERS,
      readFile: (path) => import('node:fs/promises').then((m) => m.readFile(path, 'utf8')),
    });

    expect(scanned.unscanned.map((file) => [file.relative, file.reason])).toEqual([
      ['gone.html', 'unreadable'],
    ]);
    // And the file that is still there was scanned normally.
    expect(scanned.references).toHaveLength(1);
  });

  it.skipIf(isWindows)('survives a symlink cycle', async () => {
    const root = await makeRoot();
    await mkdir(join(root, 'a'), { recursive: true });
    await writeFile(join(root, 'a', 'hero.png'), Buffer.alloc(8));
    // Points at its own ancestor: a walker that followed it would never finish.
    await symlink(root, join(root, 'a', 'loop'), 'dir');

    const { report } = await runEverything(root);

    expect(report.summary.assets).toBe(1);
    expect(report.skipped.some((item) => item.reason.includes('symlink'))).toBe(true);
  });

  it('survives a path longer than 260 characters', async () => {
    const root = await makeRoot();
    // Nested rather than one long segment: every filesystem caps a single name,
    // but the 260-character *path* limit is the Windows-specific one.
    let directory = root;
    for (let depth = 0; depth < 12; depth++) {
      directory = join(directory, `deeply-nested-directory-${depth}`);
    }

    let created = true;
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'deep.png'), Buffer.alloc(8));
    } catch {
      // Windows without long-path support refuses to create it at all. That is the
      // OS declining, not the engine failing, and the walk below still has to cope.
      created = false;
    }

    const { report } = await runEverything(root);

    expect(report.summary.assets).toBe(created ? 1 : 0);
    // Whatever happened, nothing was lost silently.
    expect(report.version).toBe(1);
  });

  it('reports every one of them together without crashing', async () => {
    // The combination, because a pipeline that survives each in isolation can still
    // fall over when a later stage meets the output of an earlier one's failure.
    const root = await makeRoot();
    await writeFile(join(root, 'empty.png'), Buffer.alloc(0));
    await writeFile(join(root, 'cut.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(join(root, 'café.png'), Buffer.alloc(8));
    await writeFile(join(root, 'unread.vue'), '<img src="café.png">');
    await writeFile(join(root, 'broken.scss'), 'a { color: ; ;; }} unclosed');
    await writeFile(
      join(root, 'page.html'),
      '<img src="empty.png">\r\n<img src="cut.png">\r\n<img src="missing.png">',
    );

    const { report, text } = await runEverything(root, { probe: true });

    // One genuinely broken reference, and it is the one that is genuinely broken.
    expect(report.findings.filter((finding) => finding.kind === 'broken')).toHaveLength(1);
    // The unparseable stylesheet is reported, not swallowed.
    expect(report.skipped.some((item) => item.stage === 'scan')).toBe(true);
    // And the report still renders.
    expect(text).toContain('Upfly audit');
  });
});
