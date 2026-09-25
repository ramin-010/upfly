/**
 * Running `optimize` a second time finds nothing left to do.
 *
 * A user will run it twice: once to see what it does and once because they forgot, or on
 * every push in CI. So each fixture is copied and optimized twice, under both policies,
 * through `optimizeTree`, the path the exit criterion runs. The second run must convert
 * nothing, rewrite nothing, delete nothing, and leave every byte where the first run put it.
 *
 * What keeps it true is not obvious, which is why the test names it. After a
 * `keep-original` run a converted image exists twice: `logo.png`, which nothing links to
 * any more, and `logo.webp`, which its references now point at. The second run sees a
 * public image nothing links to, and under `keep-original` that is worth converting. It
 * is declined only because `logo.webp` already exists. The converted file is never
 * converted again, because swapping its extension changes nothing.
 */

import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type OptimizeResult,
  type PublicPolicy,
  type ServingRoots,
  buildReport,
  runPipeline,
  servingRootsFor,
} from 'upfly-core';
import { afterAll, describe, expect, it } from 'vitest';
import { optimizeTree } from './engine-run.js';

const FIXTURES_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures');

/**
 * The serving roots a fixture declares, where it declares one. The same as the exit
 * criterion's harness and the fixture's own tests: eleventy serves from `src`, which no
 * detector should claim by name, and the partial-pattern tree has no project file beside
 * its `public` folder, so detection rightly does not claim it.
 */
const DECLARED: Readonly<Record<string, ServingRoots>> = {
  eleventy: { dirs: ['src'], declared: true },
  'partial-pattern': { dirs: ['public'], declared: true },
};

const FIXTURES = ['astro', 'eleventy', 'next-app', 'partial-pattern', 'plain-html', 'vite-react'];
const POLICIES: readonly PublicPolicy[] = ['keep-original', 'replace'];

/** Dependencies and build output: nothing the engine reads, and slow to copy. */
const NEVER_COPY = new Set(['node_modules', 'dist', '_site', '.next', 'out', 'build', '.astro']);

/**
 * A copy outside the workspace. Never inside it: the v2 extension converts images in any
 * `public/` folder it watches and deletes the originals.
 */
async function copyOf(fixture: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `upfly-twice-${fixture}-`));
  await cp(join(FIXTURES_ROOT, fixture), root, {
    recursive: true,
    filter: (entry) => !NEVER_COPY.has(entry.slice(entry.lastIndexOf(sep) + 1)),
  });
  return root;
}

/** Every file under `root`, `.upfly/` included, as a path and a hash of its bytes. */
async function snapshot(root: string, prefix = ''): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix === '' ? entry.name : posix.join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(files, await snapshot(root, path));
    else
      files[path] = createHash('sha256')
        .update(await readFile(join(root, path)))
        .digest('hex');
  }
  return files;
}

function deletesIn(result: OptimizeResult): number {
  return (result.manifest?.operations ?? []).filter((operation) => operation.kind === 'delete')
    .length;
}

/** How many originals each first `replace` run deleted, for the premise below. */
const deletedByReplace: Record<string, number> = {};

describe('optimize, run a second time', () => {
  for (const fixture of FIXTURES) {
    for (const policy of POLICIES) {
      it(`${fixture} under ${policy}: converts nothing, rewrites nothing, deletes nothing`, async () => {
        const root = await copyOf(fixture);
        try {
          const first = await optimizeTree(root, DECLARED[fixture], policy);
          expect(first.refusal).toBeNull();
          // A first run that changed nothing would make the second run's silence prove
          // nothing: an untouched tree is not a test of idempotence.
          expect(first.plan.conversions.length).toBeGreaterThan(0);
          expect(first.manifest?.state).toBe('committed');
          if (policy === 'replace') deletedByReplace[fixture] = deletesIn(first);
          const afterFirst = await snapshot(root);

          const second = await optimizeTree(root, DECLARED[fixture], policy);

          expect(second.refusal).toBeNull();
          expect(second.plan.conversions).toEqual([]);
          expect(second.plan.rewrites).toEqual([]);
          expect(second.manifest).toBeNull();
          expect(await snapshot(root)).toEqual(afterFirst);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });
    }
  }

  afterAll(() => {
    // Premise, asserted once all fixtures ran: `replace` must have deleted originals
    // somewhere, or its second runs only ever re-read trees where nothing was removed.
    // Skipped when the tests were filtered down to a subset.
    if (Object.keys(deletedByReplace).length === FIXTURES.length) {
      expect(
        Object.values(deletedByReplace).reduce((sum, count) => sum + count, 0),
      ).toBeGreaterThan(0);
    }
  });
});

describe('the audit after a keep-original run', () => {
  it('lists each original kept beside its converted file apart from the unused images', async () => {
    const root = await copyOf('vite-react');
    try {
      const run = await optimizeTree(root, undefined, 'keep-original');
      const converted = new Set(run.plan.conversions.map((conversion) => conversion.asset));

      // What `upfly audit` runs.
      const output = await runPipeline({
        root,
        servingRoots: servingRootsFor(undefined),
        publicDirs: (servingRoots) => servingRoots.dirs,
        probeOptions: null,
      });
      const report = buildReport({
        graph: output.graph,
        audit: output.audit,
        discovery: output.discovery,
        sweep: output.sweep,
        servingRoots: output.servingRoots,
      });

      const unlinkedOriginals = output.graph.assets
        .filter((node) => converted.has(node.asset.relative) && node.references.length === 0)
        .map((node) => node.asset.relative)
        .sort();
      // The case itself must be here: originals the references moved away from.
      expect(unlinkedOriginals.length).toBeGreaterThan(0);

      expect(report.keptOriginals.assets.map((entry) => entry.asset).sort()).toEqual(
        unlinkedOriginals,
      );
      const dead = new Set(
        report.findings.filter((finding) => finding.kind === 'dead').map((f) => f.asset),
      );
      expect(unlinkedOriginals.filter((asset) => dead.has(asset))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
