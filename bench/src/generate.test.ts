/**
 * The bench tree must be able to refute the optimisation it is used to justify: skipping
 * the markdown adapter's parse5 pass. A tree whose markdown never held a tag would show
 * the skip as safe whatever it lost.
 *
 * The assertions are bands, not exact counts. The rates are drawn per document from a
 * seeded generator, so an exact count would describe this seed rather than the tree; a
 * band still catches a class going to zero.
 *
 * The refuting check goes through the markdown adapter rather than a regex. A document
 * can contain `<img` and still hold no reference the adapter reads, and what a skip would
 * lose is a reference the adapter finds.
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

/**
 * These build and parse thousands of documents, which takes close to vitest's 5-second
 * default on an idle machine, so the default would fail them on a busy one. The budget is
 * explicit and generous because these are measurements rather than unit tests.
 */
const BUDGET_MS = 60_000;
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

    // A throw is a third outcome, and it is counted: swallowing one would silently shrink
    // the very class this file exists to prove is non-empty.
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
  it(
    '🔴 contains documents where skipping the parse5 pass LOSES a reference',
    () => {
      // 1,200 of each: the real rate is about 1%, so a sample of 100 would hold about one
      // such document, and the test would pass or fail on a single draw.
      const md = sampleMarkdown('.md', 1_200, 0xbeef_0001);
      const mdx = sampleMarkdown('.mdx', 1_200, 0xbeef_0002);

      expect(md.refuting).toBeGreaterThan(0);
      expect(mdx.refuting).toBeGreaterThan(0);
      expect(md.lostReferences).toBeGreaterThan(0);
      expect(mdx.lostReferences).toBeGreaterThan(0);
    },
    BUDGET_MS,
  );

  it(
    'puts the refuting class near the measured 0.9%, not at a convenient rate',
    () => {
      const md = sampleMarkdown('.md', 1_200, 0xbeef_0003);
      const mdx = sampleMarkdown('.mdx', 1_200, 0xbeef_0004);
      const rate = (md.refuting + mdx.refuting) / (md.documents + mdx.documents);

      // The band matters in both directions. Too low and the tree cannot refute; too high
      // and it overstates what the skip would cost, arguing against an optimisation on
      // evidence the tree invented.
      expect(rate).toBeGreaterThan(0.003);
      expect(rate).toBeLessThan(0.03);
    },
    BUDGET_MS,
  );

  it(
    'carries markup in roughly the 71.5% of documents the real corpus does',
    () => {
      const md = sampleMarkdown('.md', 800, 0xbeef_0005);
      const mdx = sampleMarkdown('.mdx', 800, 0xbeef_0006);
      const rate = (md.withTag + mdx.withTag) / (md.documents + mdx.documents);

      expect(rate).toBeGreaterThan(0.6);
      expect(rate).toBeLessThan(0.85);
    },
    BUDGET_MS,
  );

  it(
    'no markdown document fails to parse',
    () => {
      const md = sampleMarkdown('.md', 400, 0xbeef_0007);
      const mdx = sampleMarkdown('.mdx', 400, 0xbeef_0008);

      expect(md.threw).toBe(0);
      expect(mdx.threw).toBe(0);
    },
    BUDGET_MS,
  );
});

describe('the generated tree is written in the language its extension claims', () => {
  it(
    '🔴 emits `.js` that parses as JavaScript',
    () => {
      // Babel rejects TypeScript in a `.js` file, and a rejected file's parse cost is the
      // cost of failing, so a `.js` file with type annotations would skew the timing.
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
    },
    BUDGET_MS,
  );

  it(
    'still emits `.ts` that carries type annotations, so the swap did not widen',
    () => {
      const random = rng(0xbeef_000a);
      const text = buildFileText('.ts', 'src/a/b/c/d', IMAGES, random);

      // The guard against fixing `.js` by making every file annotation-free, which
      // would quietly cut the tree's TypeScript parse cost and look like a win.
      expect(text).toMatch(/: number/);
    },
    BUDGET_MS,
  );
});
