/**
 * The bench tree must be able to REFUTE the optimisation it is used to justify.
 *
 * 🔴 **R126, and it is the reason this file exists.** Until 2026-09-17 the tree's
 * markdown could not contain an angle bracket by construction — the head emitted
 * `# Title`, `![alt]()` and `[link]()`, the filler emitted `## heading` plus prose.
 * So *"skipping the parse5 pass is safe on 2,640 of 2,640 documents"* was a property
 * of `generate.ts`, not a measurement, and ~20% of the graph build was parse5 looking
 * for HTML that could never be there. **A corpus that can confirm but not refute is
 * not evidence (R117).**
 *
 * ⚠️ **These assertions are bands, not equalities, and they are deliberately loose.**
 * The rates are drawn per document from a seeded PRNG, so an exact count would be a
 * snapshot of this seed rather than a statement about the tree. What matters is that
 * each class is NON-EMPTY and roughly where the real corpus puts it; a band catches
 * the failure this was written for — a class silently going to zero — without
 * breaking every time a draw order changes.
 *
 * ⚠️ **And the refuting assertion is made through the ENGINE, not against a regex.**
 * Asking *"does the text contain `<img`"* would pass on a document the adapter cannot
 * actually read. The question is whether the markdown adapter finds a reference whose
 * shape is HTML-born, because that is exactly the reference a skip would lose.
 */

import { defaultAdapters } from 'upfly-core';
import { describe, expect, it } from 'vitest';
import { buildFileText } from './generate.js';

const markdown = defaultAdapters.find((adapter) => adapter.id === 'markdown');

/**
 * The three shapes `asMarkdownShape` stamps on a reference the HTML adapter found.
 *
 * Every one of them is reachable only through the parse5 pass: Markdown's own regexes
 * match `![alt](path)` and `[label]: path`, so nothing here can come from them.
 */
const HTML_BORN = new Set(['md.raw-html', 'mdx.jsx', 'md.style-attribute']);

/** The generator's PRNG, copied here so the sample is reproducible run to run. */
function rng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const IMAGES = ['public/img/a.png', 'public/img/b.jpg', 'public/img/c.webp'];
const ANY_TAG = /<[a-zA-Z][^>]*>/;

interface Sample {
  readonly documents: number;
  readonly withTag: number;
  readonly refuting: number;
  readonly lostReferences: number;
  readonly threw: number;
}

function sampleMarkdown(extension: string, count: number, seed: number): Sample {
  if (markdown === undefined) throw new Error('markdown adapter missing');
  const random = rng(seed);

  let withTag = 0;
  let refuting = 0;
  let lostReferences = 0;
  let threw = 0;

  for (let index = 0; index < count; index++) {
    const file = `src/a/b/c/d/file-${index}${extension}`;
    const text = buildFileText(extension, 'src/a/b/c/d', IMAGES, random);
    if (ANY_TAG.test(text)) withTag++;

    // R86: a throw is a third outcome. Swallowing one here would silently shrink the
    // very class this file exists to prove is non-empty.
    let born = 0;
    try {
      born = markdown
        .findReferences({ file, text })
        .filter((reference) => HTML_BORN.has(reference.shape)).length;
    } catch {
      threw++;
    }
    if (born > 0) {
      refuting++;
      lostReferences += born;
    }
  }

  return { documents: count, withTag, refuting, lostReferences, threw };
}

describe('the generated tree can refute a markdown optimisation', () => {
  it('🔴 contains documents where skipping the parse5 pass LOSES a reference', () => {
    // 1,200 of each, because the real rate is ~1% and a sample of 100 would be
    // expected to contain one — a test that passes or fails on a single draw is a
    // coin flip wearing an assertion's clothes.
    const md = sampleMarkdown('.md', 1_200, 0xbeef_0001);
    const mdx = sampleMarkdown('.mdx', 1_200, 0xbeef_0002);

    expect(md.refuting).toBeGreaterThan(0);
    expect(mdx.refuting).toBeGreaterThan(0);
    expect(md.lostReferences).toBeGreaterThan(0);
    expect(mdx.lostReferences).toBeGreaterThan(0);
  });

  it('puts the refuting class near the measured 0.9%, not at a convenient rate', () => {
    const md = sampleMarkdown('.md', 1_200, 0xbeef_0003);
    const mdx = sampleMarkdown('.mdx', 1_200, 0xbeef_0004);
    const rate = (md.refuting + mdx.refuting) / (md.documents + mdx.documents);

    // 🔴 The band matters in BOTH directions. Too low and the tree cannot refute;
    // too high and the tree overstates what a skip would cost, which would argue
    // against an optimisation on evidence the corpus invented.
    expect(rate).toBeGreaterThan(0.003);
    expect(rate).toBeLessThan(0.03);
  });

  it('carries markup in roughly the 71.5% of documents the real corpus does', () => {
    const md = sampleMarkdown('.md', 800, 0xbeef_0005);
    const mdx = sampleMarkdown('.mdx', 800, 0xbeef_0006);
    const rate = (md.withTag + mdx.withTag) / (md.documents + mdx.documents);

    expect(rate).toBeGreaterThan(0.6);
    expect(rate).toBeLessThan(0.85);
  });

  it('no markdown document fails to parse', () => {
    const md = sampleMarkdown('.md', 400, 0xbeef_0007);
    const mdx = sampleMarkdown('.mdx', 400, 0xbeef_0008);

    expect(md.threw).toBe(0);
    expect(mdx.threw).toBe(0);
  });
});

describe('the generated tree is written in the language its extension claims', () => {
  it('🔴 emits `.js` that parses as JavaScript', () => {
    // 128 of the tree's 160 `.js` files were TypeScript and Babel rejected every one,
    // so their measured parse cost was the cost of FAILING (R124). The engine was
    // right about them; the measurement was not.
    const javascript = defaultAdapters.find((adapter) => adapter.id === 'javascript');
    if (javascript === undefined) throw new Error('javascript adapter missing');

    const random = rng(0xbeef_0009);
    let threw = 0;

    for (let index = 0; index < 120; index++) {
      const text = buildFileText('.js', 'src/a/b/c/d', IMAGES, random);
      try {
        javascript.findReferences({ file: `src/a/b/c/d/file-${index}.js`, text });
      } catch {
        threw++;
      }
    }

    expect(threw).toBe(0);
  });

  it('still emits `.ts` that carries type annotations, so the swap did not widen', () => {
    const random = rng(0xbeef_000a);
    const text = buildFileText('.ts', 'src/a/b/c/d', IMAGES, random);

    // The guard against fixing `.js` by making every file annotation-free, which
    // would quietly cut the tree's TypeScript parse cost and look like a win.
    expect(text).toMatch(/: number/);
  });
});
