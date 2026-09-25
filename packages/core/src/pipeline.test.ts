import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type PipelineProgress, runPipeline, servingRootsFor } from './pipeline.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A small site outside the workspace. The images are never decoded here. */
function site(): string {
  const root = mkdtempSync(join(tmpdir(), 'upfly-pipeline-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': '{ "name": "site", "private": true }\n',
    'index.html': '<img src="/logo.png"><img src="legacy/old.png">\n',
    'public/logo.png': 'logo, never decoded',
    'legacy/old.png': 'an older picture, never decoded',
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

describe('runPipeline', () => {
  it('reports each stage as it finishes, with what it counted', async () => {
    const events: PipelineProgress[] = [];
    await runPipeline({
      root: site(),
      servingRoots: servingRootsFor(),
      publicDirs: (servingRoots) => servingRoots.dirs,
      probeOptions: null,
      onProgress: (event) => events.push(event),
    });

    expect(events).toEqual([
      { stage: 'discovered', images: 2, files: 2 },
      { stage: 'scanned', references: 2 },
      { stage: 'resolved', linked: 2 },
      { stage: 'audited', findings: 0 },
    ]);
  });

  it('decides the serving roots itself unless they are declared', async () => {
    const root = site();
    const decided = await runPipeline({
      root,
      servingRoots: servingRootsFor(),
      publicDirs: (servingRoots) => servingRoots.dirs,
      probeOptions: null,
    });
    const declared = await runPipeline({
      root,
      servingRoots: servingRootsFor({ dirs: [''], declared: true }),
      publicDirs: (servingRoots) => servingRoots.dirs,
      probeOptions: null,
    });

    expect(decided.servingRoots).toEqual({ dirs: ['public'], declared: false });
    expect(declared.servingRoots).toEqual({ dirs: [''], declared: true });
  });

  it('leaves out what extraIgnores names, as .upflyignore would', async () => {
    const output = await runPipeline({
      root: site(),
      servingRoots: servingRootsFor(),
      publicDirs: (servingRoots) => servingRoots.dirs,
      probeOptions: null,
      extraIgnores: ['legacy/'],
    });

    expect(output.discovery.assets.map((asset) => asset.relative)).toEqual(['public/logo.png']);
    expect(output.discovery.excludedRoots.map((excluded) => excluded.relative)).toEqual(['legacy']);
  });
});
