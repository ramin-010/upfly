import { describe, expect, it } from 'vitest';
import { buildGraph } from './graph.js';
import { MINIMUM_ROOT_RELATIVE, RESOLUTION_FLOOR, resolutionHealth } from './resolution-health.js';
import type { Asset, RawReference, Reference } from './types.js';

const ROOT = '/repo';

function asset(relative: string): Asset {
  return { path: `${ROOT}/${relative}`, relative, extension: '.png', bytes: 1_000 };
}

const RAW: Omit<RawReference, 'file' | 'rawPath' | 'start' | 'end'> = {
  kind: 'attr',
  ceiling: 'high',
  asserted: true,
};

function reference(rawPath: string, over: Partial<Reference>): Reference {
  return {
    ...RAW,
    file: `${ROOT}/index.html`,
    rawPath,
    start: 0,
    end: rawPath.length,
    ...over,
  } as Reference;
}

function linked(rawPath: string, target: string): Reference {
  return reference(rawPath, {
    resolution: 'resolved',
    confidence: 'high',
    resolvedPath: `${ROOT}/${target}`,
    resolvedVia: 'serving-root',
  });
}

function broken(rawPath: string): Reference {
  return reference(rawPath, { resolution: 'broken', confidence: 'unsafe', resolvedPath: null });
}

function health(references: readonly Reference[], assets: readonly Asset[] = []) {
  return resolutionHealth(
    buildGraph({
      root: ROOT,
      assets: [...assets],
      references: [...references],
      unscannedFiles: [],
    }),
  );
}

/** `n` root-relative references, of which `linkedCount` resolve. */
function mix(n: number, linkedCount: number): { refs: Reference[]; assets: Asset[] } {
  const assets: Asset[] = [];
  const refs: Reference[] = [];
  for (let index = 0; index < n; index++) {
    if (index < linkedCount) {
      assets.push(asset(`public/a${index}.png`));
      refs.push(linked(`/a${index}.png`, `public/a${index}.png`));
    } else {
      refs.push(broken(`/missing${index}.png`));
    }
  }
  return { refs, assets };
}

describe('resolutionHealth', () => {
  it('counts root-relative references that linked against those it could check', () => {
    const { refs, assets } = mix(4, 3);

    expect(health(refs, assets)).toMatchObject({ linked: 3, checkable: 4, rate: 0.75 });
  });

  it('ignores file-relative references, which no serving root decides', () => {
    // The narrowing that makes the diagnosis correct rather than merely likely. A
    // repository whose relative imports are genuinely broken scores normally here and
    // keeps every one of its findings.
    const { refs, assets } = mix(12, 12);
    const alsoBroken = Array.from({ length: 50 }, (_, index) => broken(`./gone${index}.png`));

    const result = health([...refs, ...alsoBroken], assets);

    expect(result.checkable).toBe(12);
    expect(result.servingRootUnknown).toBe(false);
  });

  it('ignores references that are not evidence about a serving root', () => {
    // A discarded guess out of a lockfile says nothing about where the site serves
    // from, and counting it would make a large package.json look like a
    // misconfiguration.
    const noise = [
      reference('/a.png', { resolution: 'discarded', confidence: 'unsafe', resolvedPath: null }),
      reference('/b.png', { resolution: 'dynamic', confidence: 'unsafe', resolvedPath: null }),
      reference('/c.png', {
        resolution: 'unresolved-alias',
        confidence: 'unsafe',
        resolvedPath: null,
      }),
    ];

    expect(health(noise)).toMatchObject({ linked: 0, checkable: 0, rate: 1 });
  });

  it('reports a rate of 1 when there is nothing to check, rather than dividing by zero', () => {
    expect(health([])).toMatchObject({ checkable: 0, rate: 1, servingRootUnknown: false });
  });

  it('calls the serving root unknown when the share is below the floor', () => {
    const { refs, assets } = mix(20, 1);

    expect(health(refs, assets).servingRootUnknown).toBe(true);
  });

  it('says nothing when the share is above the floor, however many are broken', () => {
    const { refs, assets } = mix(20, 19);

    expect(health(refs, assets).servingRootUnknown).toBe(false);
  });

  it('refuses to judge a sample too small to be a measurement', () => {
    // One root-relative reference that is genuinely broken would otherwise score zero
    // and have its one true finding suppressed.
    const { refs, assets } = mix(MINIMUM_ROOT_RELATIVE - 1, 0);
    const result = health(refs, assets);

    expect(result.rate).toBe(0);
    expect(result.servingRootUnknown).toBe(false);
  });

  it('judges a sample exactly at the minimum', () => {
    const { refs, assets } = mix(MINIMUM_ROOT_RELATIVE, 0);

    expect(health(refs, assets).servingRootUnknown).toBe(true);
  });

  it('sits in the gap between the two measured populations', () => {
    // Measured across the five validation repositories in both states, root-relative
    // references only. Correctly configured or correctly detected: 89.6% on
    // shadcn-ui, 96.9% on scratch-www, 99.3% on railsgirls-com, 100% on astro-docs
    // and eleventy-docs. With no serving root found at all: 0.0% on four of them, and
    // railsgirls-com unchanged because it genuinely serves from its own root.
    //
    // The floor is not near either population. These assertions are what would fail
    // if somebody moved it to the edge of one.
    expect(RESOLUTION_FLOOR).toBeGreaterThan(0);
    expect(RESOLUTION_FLOOR).toBeLessThan(0.896);
  });
});
