/**
 * R132's bar, tested against the cases that SET it rather than against invented ones.
 *
 * 🔴 **The impostor is the centre of this file.** R128 measured a directory named `public`
 * that serves nothing and resolves one reference out of one — a perfect rate — while the
 * four genuine roots beside it scored 45.8% to 80%. Any bar phrased as a resolution rate
 * accepts the impostor and rejects every real root, so the discriminator has to be VOLUME.
 * These tests assert that, not the arithmetic.
 *
 * ⚠️ **And a rejected root is a no-op (R140)**, which is why refusing on a tie is cheap:
 * the reference stays exactly where it already sits. A false ACCEPT is the expensive one,
 * so every assertion below that could be loosened into an acceptance is deliberately not.
 */

import { describe, expect, it } from 'vitest';
import {
  MIN_ROOT_REFERENCES,
  MIN_ROOT_RESOLUTION_RATE,
  inferServingRoots,
} from './infer-serving-roots.js';

describe('inferServingRoots finds what a name cannot', () => {
  it("🔴 finds eleventy's `src`, which no name-based rule may claim", () => {
    // The case R71-b named. `src` is a source directory by convention, so
    // CONVENTIONAL_SERVING_ROOT_NAMES deliberately excludes it — and it is this
    // repository's actual serving root.
    const result = inferServingRoots({
      assets: ['src/img/a.png', 'src/img/b.png', 'src/img/c.png', 'docs/unrelated.png'],
      references: [
        { file: 'docs/page.md', path: '/img/a.png' },
        { file: 'docs/page.md', path: '/img/b.png' },
        { file: 'docs/page.md', path: '/img/c.png' },
      ],
    });

    expect(result.dirs).toEqual(['src']);
    expect(result.ties).toEqual([]);
  });

  it('reaches a sibling public directory through an ancestor, as a bundler does', () => {
    // `templates/next-app/public` is not an ancestor of `templates/next-app/src/`, so an
    // ancestors-only walk never reaches it. The child rung is what makes shadcn-ui's
    // twelve roots findable.
    const result = inferServingRoots({
      assets: [
        'templates/next-app/public/a.png',
        'templates/next-app/public/b.png',
        'templates/next-app/public/c.png',
      ],
      references: [
        { file: 'templates/next-app/src/App.tsx', path: '/a.png' },
        { file: 'templates/next-app/src/App.tsx', path: '/b.png' },
        { file: 'templates/next-app/src/App.tsx', path: '/c.png' },
      ],
    });

    expect(result.dirs).toEqual(['templates/next-app/public']);
  });

  it('🔴 never crosses to a SIBLING app, which is the 93-false-broken failure', () => {
    // `apps/one/src` must not resolve against `apps/two/public`. That is not a missed
    // opportunity, it is the false LINK R49 measured and called the worse failure.
    const result = inferServingRoots({
      assets: ['apps/two/public/a.png', 'apps/two/public/b.png', 'apps/two/public/c.png'],
      references: [
        { file: 'apps/one/src/App.tsx', path: '/a.png' },
        { file: 'apps/one/src/App.tsx', path: '/b.png' },
        { file: 'apps/one/src/App.tsx', path: '/c.png' },
      ],
    });

    expect(result.dirs).toEqual([]);
  });
});

describe('the bar is volume, because a rate alone points the wrong way', () => {
  it('🔴 rejects the impostor: a perfect rate over too few references', () => {
    // `docs-examples/public` — a directory named `public` that serves nothing. It scores
    // 100%, which is why a rate-only bar takes it.
    const result = inferServingRoots({
      assets: ['docs-examples/public/sample.png'],
      references: [{ file: 'docs-examples/public/example.html', path: '/sample.png' }],
    });

    expect(result.dirs).toEqual([]);
  });

  it('accepts the same shape once it clears the volume floor', () => {
    // The guard on the guard: if this also came back empty the floor would be rejecting
    // by accident rather than by volume, and the test above would prove nothing.
    const assets = ['site/public/a.png', 'site/public/b.png', 'site/public/c.png'];
    const result = inferServingRoots({
      assets,
      references: assets.map((asset) => ({
        file: 'site/src/page.html',
        path: `/${asset.split('/').pop()}`,
      })),
    });

    expect(result.dirs).toEqual(['site/public']);
    expect(assets).toHaveLength(MIN_ROOT_REFERENCES);
  });

  it('rejects a candidate that resolves too little of what it is offered', () => {
    // Four references, one hit: 25%, under the 40% floor. R51's 25% is deliberately NOT
    // reused here — it answers a different question about the whole repository.
    const result = inferServingRoots({
      assets: ['public/a.png'],
      references: [
        { file: 'src/page.html', path: '/a.png' },
        { file: 'src/page.html', path: '/b.png' },
        { file: 'src/page.html', path: '/c.png' },
        { file: 'src/page.html', path: '/d.png' },
      ],
    });

    expect(0.25).toBeLessThan(MIN_ROOT_RESOLUTION_RATE);
    expect(result.dirs).toEqual([]);
  });
});

describe('a tie refuses and is kept for a human', () => {
  it("🔴 refuses when two candidates resolve everything, as railsgirls' favicon does", () => {
    // The real instance: `favicon.png` exists at the project root AND inside `images/`,
    // so `/favicon.png` resolves under either. No inference can break that — both answers
    // are consistent with every byte in the repository — so it must not try.
    const result = inferServingRoots({
      assets: [
        'favicon.png',
        'apple-touch-icon.png',
        'logo.png',
        'images/favicon.png',
        'images/apple-touch-icon.png',
        'images/logo.png',
      ],
      references: [
        { file: 'files/galway/index.html', path: '/favicon.png' },
        { file: 'files/galway/index.html', path: '/apple-touch-icon.png' },
        { file: 'files/galway/index.html', path: '/logo.png' },
      ],
    });

    expect(result.dirs).toEqual([]);
    expect(result.ties).toHaveLength(1);
    // ⚠️ Kept rather than dropped: under `init` a human is shown these and may choose.
    expect(result.ties[0]?.candidates).toEqual(['', 'images']);
  });
});

describe('what it reports about itself', () => {
  it('carries the evidence that accepted each root', () => {
    // A root accepted with no way to show why is a guess nobody can audit, which is the
    // defect serving-root detection exists to fix.
    const result = inferServingRoots({
      assets: ['public/a.png', 'public/b.png', 'public/c.png'],
      references: [
        { file: 'index.html', path: '/a.png' },
        { file: 'index.html', path: '/b.png' },
        { file: 'index.html', path: '/c.png' },
      ],
    });

    expect(result.evidence).toEqual([{ dir: 'public', resolved: 3, attempted: 3, rate: 1 }]);
  });

  it('returns nothing, and that is an answer', () => {
    // A hand-written static site serves from its own root. The resolver reaches that
    // through the project-root rung with no serving root at all.
    expect(inferServingRoots({ assets: [], references: [] }).dirs).toEqual([]);
  });
});
