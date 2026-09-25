import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
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
