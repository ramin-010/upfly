import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { optimizeFromPipeline, optimizeProject } from './optimize-project.js';
import { runPipeline, servingRootsFor } from './pipeline.js';
import { convertibleImages } from './plan/plan.js';
import type { PublicPolicy } from './plan/plan.js';
import type { ServingRoots } from './resolve/resolve.js';
import type { OptimizeResult } from './write/optimize.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures');

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** What a plan converts and keeps, without the reasons a run that measured less leaves out. */
function decisions(result: OptimizeResult) {
  return {
    conversions: result.plan.conversions,
    keptOriginals: result.plan.keptOriginals,
    rewrites: result.plan.rewrites,
  };
}

/** A dry run planned from the measurements of only the images a plan could convert. */
async function plannedFromConvertible(
  root: string,
  publicPolicy: PublicPolicy,
  declared?: ServingRoots,
  maxEncodedAssets?: number,
) {
  const pipeline = await runPipeline({
    root,
    servingRoots: servingRootsFor(declared),
    publicDirs: (servingRoots) => servingRoots.dirs,
    probeOptions: {
      formats: ['webp'],
      ...(maxEncodedAssets === undefined ? {} : { maxEncodedAssets }),
    },
    encodeOnly: (built) => convertibleImages({ ...built, format: 'webp' }),
  });
  return {
    pipeline,
    result: await optimizeFromPipeline(pipeline, { format: 'webp', publicPolicy, apply: false }),
  };
}

describe('a plan from the measurements of the images it could convert', () => {
  it.each([
    ['plain-html', 'keep-original'],
    ['plain-html', 'replace'],
    ['vite-react', 'keep-original'],
    ['vite-react', 'replace'],
    ['partial-pattern', 'replace'],
  ] as const)(
    'is the plan made from every image measured (%s, %s)',
    async (fixture, policy) => {
      const root = join(FIXTURES, fixture);

      const everything = await optimizeProject({
        root,
        format: 'webp',
        publicPolicy: policy,
        apply: false,
      });
      const { result } = await plannedFromConvertible(root, policy);

      expect(everything.optimize.plan.conversions.length).toBeGreaterThan(0);
      expect(decisions(result)).toEqual(decisions(everything.optimize));
    },
    60_000,
  );
});

describe('a plan from a capped measurement', () => {
  it('converts no image the full plan would not, measuring together images whose converted files share a name', async () => {
    // logo.png and logo.jpg would both become a/logo.webp, so the full plan converts neither.
    // A cap of two takes big.png and logo.png; measured without logo.jpg, logo.png would
    // seem free to convert.
    const root = await mkdtemp(join(tmpdir(), 'upfly-capped-plan-'));
    roots.push(root);
    const image = (name: string) => readFile(join(FIXTURES, 'plain-html/images', name));
    await mkdir(join(root, 'a'));
    await mkdir(join(root, 'b'));
    await writeFile(join(root, 'b/big.png'), await image('inline.png'));
    await writeFile(join(root, 'a/logo.png'), await image('texture.png'));
    await writeFile(join(root, 'a/logo.jpg'), await image('hero.jpg'));
    await writeFile(
      join(root, 'index.html'),
      '<img src="b/big.png" alt=""><img src="a/logo.png" alt=""><img src="a/logo.jpg" alt="">\n',
    );
    const declared = { dirs: [''], declared: true };

    const everything = await optimizeProject({
      root,
      declared,
      format: 'webp',
      publicPolicy: 'replace',
      apply: false,
    });
    const capped = await plannedFromConvertible(root, 'replace', declared, 2);
    const converted = (result: OptimizeResult) =>
      result.plan.conversions.map((conversion) => conversion.asset);

    expect(converted(everything.optimize)).toEqual(['b/big.png']);
    expect(converted(capped.result)).toEqual(['b/big.png']);
    const jpg = capped.pipeline.probes?.find((probe) => probe.relative === 'a/logo.jpg');
    expect(jpg?.encoded.length).toBe(1);
  }, 60_000);
});
