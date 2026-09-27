import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { MANIFEST_PATH } from './manifest.js';
import { optimizeProject } from './optimize-project.js';
import type { OptimizeProgress } from './optimize.js';
import type { PipelineProgress } from './pipeline.js';

/** The plain HTML fixture: real images, relative references, no build step. */
const PLAIN_HTML = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/plain-html');

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A copy of the fixture outside the workspace. */
async function copy(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'upfly-optimize-project-'));
  roots.push(root);
  await cp(PLAIN_HTML, root, { recursive: true });
  return root;
}

async function files(root: string, prefix = ''): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await files(root, path)));
    else found.push(path);
  }
  return found.sort();
}

describe('optimizeProject', () => {
  it('plans without writing, reports each stage, and leaves out what it is told to', async () => {
    const root = await copy();
    const before = await files(root);
    const stages: (PipelineProgress | OptimizeProgress)['stage'][] = [];

    const { pipeline, optimize } = await optimizeProject({
      root,
      declared: { dirs: [''], declared: true },
      format: 'webp',
      publicPolicy: 'replace',
      apply: false,
      extraIgnores: ['about.html'],
      onProgress: (event) => stages.push(event.stage),
      runId: 'run-fixed',
      now: () => '2026-09-26T00:00:00.000Z',
    });

    expect(stages).toEqual(['discovered', 'scanned', 'resolved', 'measured', 'audited', 'planned']);
    expect(pipeline.servingRoots).toEqual({ dirs: [''], declared: true });
    expect(pipeline.discovery.sourceFiles.map((file) => file.relative)).not.toContain('about.html');
    expect(optimize.runId).toBe('run-fixed');
    expect(optimize.plan.conversions.length).toBeGreaterThan(0);
    expect(optimize.manifest).toBeNull();
    expect(await files(root)).toEqual(before);
  });

  it('writes nothing when the check before writing says no', async () => {
    const root = await copy();
    const before = await files(root);
    const asked: number[] = [];

    const { optimize } = await optimizeProject({
      root,
      format: 'webp',
      publicPolicy: 'keep-original',
      apply: true,
      beforeWrite: (plan) => {
        asked.push(plan.conversions.length);
        return false;
      },
    });

    expect(asked).toHaveLength(1);
    expect(optimize.manifest).toBeNull();
    expect(await files(root)).toEqual(before);
  });

  it('writes the plan and its record, taking the lock as the process it is told it is', async () => {
    const root = await copy();

    const { optimize } = await optimizeProject({
      root,
      format: 'webp',
      publicPolicy: 'keep-original',
      apply: true,
      lock: { pid: process.pid, isAlive: () => true },
    });

    expect(optimize.manifest?.state).toBe('committed');
    const written = await files(root);
    expect(written).toContain(MANIFEST_PATH);
    expect(written).toContain('images/logo.webp');
    expect(written).not.toContain('.upfly/lock');
  });
});

describe('a source file saved after the scan read it', () => {
  it('is refused, not edited at offsets counted in its old text', async () => {
    const root = await copy();
    const page = join(root, 'index.html');
    // Every reference after this line moves, which is what an editor's save does.
    const saved = `<!-- saved while the images were converting -->\n${await readFile(page, 'utf8')}`;
    const planned: string[] = [];

    const run = optimizeProject({
      root,
      format: 'webp',
      publicPolicy: 'keep-original',
      apply: true,
      beforeWrite: async (plan) => {
        planned.push(...plan.rewrites.map((rewrite) => rewrite.file));
        await writeFile(page, saved);
        return true;
      },
    });

    await expect(run).rejects.toMatchObject({ code: 'TRANSACTION_FOREIGN_CHANGE' });
    expect(planned).toContain('index.html');
    expect(await readFile(page, 'utf8')).toBe(saved);
  });
});

describe('an original that a page the run excludes still shows', () => {
  // `--exclude` and `.upflyignore` limit what a run changes. The search a delete makes
  // first reads past them, or the page they left out loses its picture while the run
  // reports that every reference to it moved.
  const OLD_PAGE = '<!doctype html>\n<img src="../images/logo.png" alt="Logo" />\n';

  async function replaceIn(root: string, extraIgnores?: readonly string[]) {
    return optimizeProject({
      root,
      declared: { dirs: [''], declared: true },
      format: 'webp',
      publicPolicy: 'replace',
      apply: true,
      ...(extraIgnores === undefined ? {} : { extraIgnores }),
    });
  }

  it.each([
    ['a directory left out with --exclude', ['legacy'], null],
    ['a directory listed in .upflyignore', undefined, 'legacy/\n'],
    ['one file left out with --exclude', ['legacy/old.html'], null],
  ] as const)('stays when %s names it', async (_how, extraIgnores, ignoreFile) => {
    const root = await copy();
    await mkdir(join(root, 'legacy'));
    await writeFile(join(root, 'legacy/old.html'), OLD_PAGE);
    if (ignoreFile !== null) await writeFile(join(root, '.upflyignore'), ignoreFile);

    const { optimize } = await replaceIn(root, extraIgnores);

    expect(await readFile(join(root, 'legacy/old.html'), 'utf8')).toBe(OLD_PAGE);
    expect(await files(root)).toContain('images/logo.png');
    const declined = optimize.plan.declined.find((entry) => entry.path === 'images/logo.png');
    expect(declined?.reason).toContain(
      'legacy/old.html:2 still names its path, in a file this run excluded',
    );
    expect(declined?.reason).not.toContain('cannot rewrite');
  });

  it('is still deleted when only a directory pruned by name, such as node_modules, names it', async () => {
    // Dependencies, caches and build output hold none of the project's own pages, and build
    // output is made again from the sources the run reads, so the search leaves them out.
    const root = await copy();
    await mkdir(join(root, 'node_modules/theme'), { recursive: true });
    await writeFile(join(root, 'node_modules/theme/old.html'), OLD_PAGE);

    const { optimize } = await replaceIn(root);

    expect(optimize.plan.conversions.map((conversion) => conversion.asset)).toContain(
      'images/logo.png',
    );
    expect(await files(root)).not.toContain('images/logo.png');
  });
});

describe('a page that is not UTF-8', () => {
  it('keeps its bytes: its reference is declined with the reason, and the rest of the run goes on', async () => {
    const root = await copy();
    // "Café" in Latin-1: 0xE9 is not UTF-8, so it reads as U+FFFD, and writing the page
    // back as UTF-8 would turn that one byte into three.
    const latin1 = Buffer.from('<p>Caf\xE9</p>\n<img src="images/logo.png" alt="">\n', 'latin1');
    await writeFile(join(root, 'latin1.html'), latin1);

    const { optimize } = await optimizeProject({
      root,
      format: 'webp',
      publicPolicy: 'keep-original',
      apply: true,
    });

    expect(optimize.manifest?.state).toBe('committed');
    expect(optimize.plan.rewrites.map((rewrite) => rewrite.file)).toEqual(
      expect.arrayContaining(['index.html']),
    );
    expect(optimize.plan.rewrites.map((rewrite) => rewrite.file)).not.toContain('latin1.html');
    expect(optimize.plan.declined).toContainEqual({
      path: 'latin1.html',
      line: null,
      reason: expect.stringContaining('not valid UTF-8'),
    });
    expect(await readFile(join(root, 'latin1.html'))).toEqual(latin1);
  });

  it('reads a name its bytes cannot spell as unknown, never as broken', async () => {
    const root = await copy();
    // `images/café.png` exists. The page names it in Latin-1, where 0xE9 reads as U+FFFD,
    // so the path the text holds names no file: whether it meant this one cannot be known.
    await cp(join(root, 'images/logo.png'), join(root, 'images/café.png'));
    const page = Buffer.from('<img src="images/caf\xE9.png" alt="">\n', 'latin1');
    await writeFile(join(root, 'latin1.html'), page);

    const { pipeline } = await optimizeProject({
      root,
      format: 'webp',
      publicPolicy: 'keep-original',
      apply: false,
    });

    const replacement = String.fromCodePoint(0xfffd);
    const broken = pipeline.audit.findings.filter(
      (finding) => finding.kind === 'broken' && finding.rawPath.includes(replacement),
    );
    expect(broken).toEqual([]);
    const reference = pipeline.graph.references.find((entry) => entry.file.endsWith('latin1.html'));
    expect(reference?.resolution).toBe('dynamic');
    expect(reference?.note).toContain('not valid UTF-8');
  });
});

describe('an image a link preview or a download link names', () => {
  it('keeps that text and its original, while the img beside it moves to the converted file', async () => {
    const root = await copy();
    // `images/logo.png` is shown here and named by the page's link preview; `images/hero.jpg`
    // is shown by index.html and offered for download here.
    const page = [
      '<!doctype html>',
      '<html lang="en">',
      '  <head>',
      '    <meta property="og:image" content="images/logo.png" />',
      '  </head>',
      '  <body>',
      '    <img src="images/logo.png" alt="Logo" />',
      '    <a href="images/hero.jpg" download>Download the picture</a>',
      '  </body>',
      '</html>',
      '',
    ].join('\n');
    await writeFile(join(root, 'share.html'), page);

    const { optimize } = await optimizeProject({
      root,
      declared: { dirs: [''], declared: true },
      format: 'webp',
      publicPolicy: 'replace',
      apply: true,
    });

    expect(optimize.manifest?.state).toBe('committed');
    expect(await readFile(join(root, 'share.html'), 'utf8')).toBe(
      page.replace('<img src="images/logo.png"', '<img src="images/logo.webp"'),
    );
    const after = await files(root);
    for (const kept of ['images/logo.png', 'images/hero.jpg']) {
      expect(after).toContain(kept);
      expect(optimize.plan.keptOriginals.map((entry) => entry.asset)).toContain(kept);
    }
    // Both images did convert: the originals stay because of the two references alone.
    expect(after).toEqual(expect.arrayContaining(['images/logo.webp', 'images/hero.webp']));
    expect(optimize.plan.declined.filter((entry) => entry.path === 'share.html')).toEqual([
      { path: 'share.html', line: null, reason: expect.stringContaining('follows') },
      { path: 'share.html', line: null, reason: expect.stringContaining('link preview') },
    ]);
  });

  it('keeps a Markdown link to an image as it keeps an HTML one, while an embed moves', async () => {
    const root = await copy();
    // `images/logo.png` is shown; `images/hero.jpg` is linked, so a reader saves the file.
    const page = '![Logo](images/logo.png)\n\n[Download the picture](images/hero.jpg)\n';
    await writeFile(join(root, 'notes.md'), page);

    const { optimize } = await optimizeProject({
      root,
      declared: { dirs: [''], declared: true },
      format: 'webp',
      publicPolicy: 'replace',
      apply: true,
    });

    expect(optimize.manifest?.state).toBe('committed');
    expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe(
      page.replace('](images/logo.png)', '](images/logo.webp)'),
    );
    expect(await files(root)).toContain('images/hero.jpg');
    expect(optimize.plan.keptOriginals.map((entry) => entry.asset)).toContain('images/hero.jpg');
  });

  it('keeps a preview path a component passes through a helper, as it keeps a plain one', async () => {
    const root = await copy();
    // The helper makes the address absolute, as crawlers require. The path inside the call
    // is found as a guess, which must still carry the rule against rewriting a preview.
    const component = [
      "const absolute = (path) => new URL(path, 'https://example.com').href;",
      '',
      'export function ShareImage() {',
      '  return <meta property="og:image" content={absolute(\'/images/logo.png\')} />;',
      '}',
      '',
    ].join('\n');
    await writeFile(join(root, 'ShareImage.jsx'), component);

    const { optimize } = await optimizeProject({
      root,
      declared: { dirs: [''], declared: true },
      format: 'webp',
      publicPolicy: 'replace',
      apply: true,
    });

    expect(optimize.manifest?.state).toBe('committed');
    expect(await readFile(join(root, 'ShareImage.jsx'), 'utf8')).toBe(component);
    // index.html's <img src> still moves to the converted file; the preview keeps the original.
    expect(await readFile(join(root, 'index.html'), 'utf8')).toContain('src="images/logo.webp"');
    expect(await files(root)).toEqual(
      expect.arrayContaining(['images/logo.png', 'images/logo.webp']),
    );
    expect(optimize.plan.keptOriginals.map((entry) => entry.asset)).toContain('images/logo.png');
    expect(optimize.plan.declined.filter((entry) => entry.path === 'ShareImage.jsx')).toEqual([
      { path: 'ShareImage.jsx', line: null, reason: expect.stringContaining('link preview') },
    ]);
  });
});

describe('an image removed after the scan read it', () => {
  it('is a refusal with a code and a sentence, not a crash', async () => {
    const root = await copy();
    const page = await readFile(join(root, 'index.html'), 'utf8');
    const converting: string[] = [];

    const run = optimizeProject({
      root,
      format: 'webp',
      publicPolicy: 'keep-original',
      apply: true,
      beforeWrite: async (plan) => {
        converting.push(...plan.conversions.map((conversion) => conversion.asset));
        await rm(join(root, 'images/logo.png'));
        return true;
      },
    });

    await expect(run).rejects.toMatchObject({
      code: 'TRANSACTION_FOREIGN_CHANGE',
      message: expect.stringContaining('images/logo.png was removed'),
    });
    expect(converting).toContain('images/logo.png');
    expect(await readFile(join(root, 'index.html'), 'utf8')).toBe(page);
  });
});
