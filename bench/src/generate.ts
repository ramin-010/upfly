/**
 * Build the repository the benchmark runs against.
 *
 * The shape is the performance budget's: 10,000 files, 2,000 of them images. Everything
 * is derived from a seed, so two runs on two machines measure the same work. A tree with
 * the right file count and the wrong content times the wrong work, so file sizes per
 * extension, the extension mix and the directory depth are measured on `astro-docs`,
 * `eleventy-docs` and `shadcn-ui`. See "The benchmark tree" in ARCHITECTURE.md.
 *
 * It is generated into the OS temp directory, never into the workspace: the v2 VS Code
 * extension watches every folder named `public` in the workspace and converts what lands
 * there in place, deleting the original.
 */

import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

/**
 * Bumped when the tree's shape changes, so an old one is never silently reused.
 *
 * A timing measured on one version describes that tree only. A new version can be slower
 * because the tree is more realistic, which is not a regression in the engine.
 */
const TREE_VERSION = 5;

export const TOTAL_FILES = 10_000;
export const TOTAL_IMAGES = 2_000;

/**
 * The image size mix.
 *
 * Long-tailed rather than uniform: most repositories are mostly icons with a handful of
 * heavy hero images, and the encode cap selects the largest first, so a uniform tree
 * would make the cap look like it does nothing.
 */
const BUCKETS = [
  { name: 'icon', width: 64, height: 64, format: 'png', count: 1_400 },
  { name: 'thumb', width: 400, height: 300, format: 'jpeg', count: 450 },
  { name: 'photo', width: 1_200, height: 800, format: 'jpeg', count: 140 },
  { name: 'hero', width: 2_400, height: 1_600, format: 'jpeg', count: 10 },
] as const;

/**
 * Source file sizes per extension: the quantiles p0, p10 … p90 and p99, measured over
 * the 8,813 source files of `astro-docs`, `eleventy-docs` and `shadcn-ui`. A draw
 * interpolates between them.
 *
 * Per extension because real repositories size files by kind. `.tsx` is the most common
 * kind and one of the smallest, so one curve for every kind gives it several times its
 * real bytes and overstates its share of parse time.
 */
const SIZE_QUANTILES = new Map<string, readonly number[]>([
  // n=3325 mean=4080
  ['.tsx', [20, 448, 703, 1019, 1359, 1718, 2208, 3063, 4191, 7073, 32133]],
  // n=605 mean=6559
  ['.ts', [0, 206, 515, 1047, 1615, 2482, 3870, 6356, 9797, 18332, 48700]],
  // n=156 mean=1244
  ['.js', [80, 111, 174, 197, 227, 448, 623, 904, 1171, 3063, 13073]],
  // n=2905 mean=6662
  ['.mdx', [127, 567, 728, 980, 1423, 2861, 4758, 7312, 10513, 16771, 50683]],
  // n=308 mean=4767
  ['.md', [80, 370, 619, 1044, 1464, 2339, 2962, 4476, 6915, 11990, 31925]],
  // n=1363 mean=3852
  ['.json', [2, 168, 231, 309, 550, 889, 1523, 2498, 3244, 5850, 60063]],
  // n=117 mean=7213
  ['.css', [24, 24, 37, 62, 347, 632, 912, 1769, 4387, 15971, 77209]],
]);

/**
 * Kinds the three repositories barely contain, so there is nothing to measure.
 *
 * `.html` has five files across all three, and `.scss`, `.vue` and `.yaml` none at all.
 * They are here for adapter and sweep coverage, not for realism, and borrowing a
 * neighbouring curve is more honest than inventing one.
 */
const BORROWED_QUANTILES = new Map<string, string>([
  ['.scss', '.css'],
  ['.html', '.md'],
  ['.vue', '.tsx'],
  ['.yaml', '.json'],
]);

/**
 * Source formats, blended across the three repositories by file count.
 *
 * `astro-docs` is 96% `.mdx`, `shadcn-ui` 61% `.tsx` and 18% `.json`, `eleventy-docs`
 * 47% `.json` and 31% `.md`. The weights down to `.css` are that blend; the four after
 * it are a coverage floor.
 */
const SOURCE_KINDS = [
  { extension: '.tsx', weight: 34 },
  { extension: '.mdx', weight: 30 },
  { extension: '.json', weight: 14 },
  { extension: '.ts', weight: 7 },
  { extension: '.md', weight: 3 },
  { extension: '.js', weight: 2 },
  { extension: '.css', weight: 2 },
  // Coverage floor. The measured mix has almost none of these, and without them two
  // adapters go unmeasured and the sweep has nothing unread to search, so its cost would
  // read as zero.
  { extension: '.scss', weight: 2 },
  { extension: '.html', weight: 2 },
  { extension: '.vue', weight: 2 },
  { extension: '.yaml', weight: 2 },
] as const;

/** The median depth measured on `astro-docs` and `shadcn-ui` is 5.2 to 5.6. */
const DIRECTORY_DEPTH = 5;

export interface GeneratedTree {
  readonly root: string;
  readonly files: number;
  readonly images: number;
}

/** Deterministic PRNG. Small, seedable, and not `Math.random`, which is neither. */
function rng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Create the tree, or reuse the one already there.
 *
 * Reuse is the default because generating it costs more than most of the
 * measurements do, and the version in the path means a shape change cannot quietly
 * reuse a stale tree.
 */
export async function generateTree(options: { fresh?: boolean } = {}): Promise<GeneratedTree> {
  const root = join(tmpdir(), `upfly-bench-v${TREE_VERSION}`);

  if (options.fresh === true) await rm(root, { recursive: true, force: true });
  else if (await exists(join(root, '.upfly-bench-complete'))) {
    return { root, files: TOTAL_FILES, images: TOTAL_IMAGES };
  }

  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });

  // The v2 extension's kill switch. The tree is outside the workspace already, so its
  // watcher cannot see it, but being wrong about that would corrupt the tree silently,
  // and the switch costs one file.
  await writeFile(
    join(root, 'upfly.config.json'),
    `${JSON.stringify({ enabled: false, watchTargets: [] }, null, 2)}\n`,
  );

  const images = await writeImages(root);
  await writeSources(root, images);
  await writeFile(join(root, '.upfly-bench-complete'), `${TREE_VERSION}\n`);

  return { root, files: TOTAL_FILES, images: TOTAL_IMAGES };
}

/** Every image, as a POSIX path relative to the root. */
async function writeImages(root: string): Promise<string[]> {
  const relatives: string[] = [];
  const random = rng(0x51ff_ee11);

  for (const bucket of BUCKETS) {
    // Real bytes, because the probe decodes them, but one real encode per bucket and
    // copies for the rest: a decoder cannot tell a copy apart, and two thousand distinct
    // encodes would take longer than the benchmark they feed.
    const master = join(root, 'public', 'img', `_master-${bucket.name}.${bucket.format}`);
    await mkdir(join(root, 'public', 'img'), { recursive: true });
    await writeMaster(master, bucket);

    for (let index = 0; index < bucket.count; index++) {
      const directory = `public/img/${bucket.name}/${Math.floor(random() * 20)}`;
      await mkdir(join(root, directory), { recursive: true });

      const relative = `${directory}/${bucket.name}-${index}.${extensionFor(bucket.format)}`;
      await cp(master, join(root, relative));
      relatives.push(relative);
    }
  }

  return relatives;
}

async function writeMaster(path: string, bucket: (typeof BUCKETS)[number]): Promise<void> {
  // Noise, not flat colour: a solid rectangle encodes to almost nothing and would
  // make every measured saving a fiction.
  const pixels = Buffer.alloc(bucket.width * bucket.height * 3);
  for (let index = 0; index < pixels.length; index++) pixels[index] = (index * 2_654_435_761) % 251;

  const pipeline = sharp(pixels, {
    raw: { width: bucket.width, height: bucket.height, channels: 3 },
  });
  await (bucket.format === 'png' ? pipeline.png() : pipeline.jpeg({ quality: 88 })).toFile(path);
}

function extensionFor(format: string): string {
  return format === 'jpeg' ? 'jpg' : format;
}

/**
 * Source files that reference the images.
 *
 * Most references resolve, and a minority land in each of the buckets the resolver has
 * to keep apart, so the benchmark exercises the resolver's whole ladder rather than one
 * rung of it.
 */
async function writeSources(root: string, images: readonly string[]): Promise<void> {
  const random = rng(0x0bad_c0de);
  const sources = TOTAL_FILES - images.length - 2; // config + completion marker
  // The last tenth is never referenced, so the sweep has candidates to look for and its
  // cost does not read as zero.
  const referenceable = images.slice(0, Math.floor(images.length * 0.9));

  const unreferenced = images.slice(Math.floor(images.length * 0.9));
  const kinds = expandWeights();
  const made = new Set<string>();
  let written = 0;

  for (let index = 0; written < sources; index++) {
    const kind = kinds[index % kinds.length] ?? '.ts';
    const directory = directoryFor(index, random);
    if (!made.has(directory)) {
      await mkdir(join(root, directory), { recursive: true });
      made.add(directory);
    }

    const path = join(root, directory, `file-${index}${kind}`);
    await writeFile(path, buildFileText(kind, directory, referenceable, random, unreferenced));
    written += 1;
  }
}

/**
 * A path five directories deep, which is what the measurement found.
 *
 * Depth is not cosmetic here: the walker recurses per level and `relativePath` runs
 * per reported path, so a tree two deep understates both. The fan-out is chosen to
 * keep directories to a plausible size rather than one file each.
 */
function directoryFor(index: number, random: () => number): string {
  const segments = ['src'];
  let scope = index;
  for (let level = 1; level < DIRECTORY_DEPTH; level++) {
    scope = Math.floor(scope / (level === 1 ? 1_600 : 8));
    segments.push(`${['area', 'module', 'group', 'unit'][level - 1] ?? 'dir'}-${scope}`);
  }
  // A little jitter so directories are not all exactly the same size, which is what
  // makes a real tree's `readdir` costs uneven.
  if (random() < 0.15) segments.push('internal');
  return segments.join('/');
}

/**
 * One draw from that extension's measured distribution.
 *
 * Interpolating between the quantiles rather than picking one keeps the tree from
 * containing exactly eleven distinct file sizes, which would be its own artefact.
 */
function targetSize(extension: string, random: () => number): number {
  const key = BORROWED_QUANTILES.get(extension) ?? extension;
  const quantiles = SIZE_QUANTILES.get(key);
  if (quantiles === undefined) return 1_000;

  // The last point is p99, so the top 1% is drawn from the p90 to p99 span rather than
  // extrapolated past it: the real maxima are single files (one 1.1 MB `.tsx`), and
  // reproducing them would let a handful of outliers swing the mean.
  const position = random() * (quantiles.length - 1);
  const lower = Math.floor(position);
  const upper = Math.min(lower + 1, quantiles.length - 1);
  const from = quantiles[lower] ?? 0;
  const to = quantiles[upper] ?? from;

  return Math.max(64, Math.floor(from + (to - from) * (position - lower)));
}

/**
 * Grow a file to its target size with content the parser still has to read.
 *
 * Padding with a comment block alone would parse more cheaply than real code, putting
 * the bytes back while understating the parse. Each kind is padded with more of what it
 * already is.
 */
function padTo(
  body: string,
  extension: string,
  target: number,
  random: () => number,
  shape: MarkdownShape = { markup: false, refuting: false },
): string {
  const parts = [body];
  let size = body.length;
  let unit = 0;

  while (size < target) {
    const chunk = filler(extension, unit, random, shape);
    parts.push(chunk);
    size += chunk.length;
    unit += 1;
  }

  // `sourceText` leaves a JSON object open so that padding can append members. Closed
  // here, or every `.json` file fails to parse and the benchmark measures the error path
  // instead of the parse path.
  if (extension === '.json') parts.push('}');

  return `${parts.join('\n')}\n`;
}

function filler(
  extension: string,
  unit: number,
  random: () => number,
  shape: MarkdownShape = { markup: false, refuting: false },
): string {
  const word = () => WORDS[Math.floor(random() * WORDS.length)] ?? 'value';

  switch (extension) {
    case '.css':
    case '.scss':
      return `.rule-${unit} { color: #${(unit * 7919) % 1000}; margin: ${unit % 12}px; padding: ${unit % 5}px ${unit % 9}px; }`;
    case '.html':
      return `  <section class="s-${unit}"><h2>${word()} ${word()}</h2><p>${word()} ${word()} ${word()} ${word()}.</p></section>`;
    case '.md':
    case '.mdx': {
      const prose = `\n## ${word()} ${word()}\n\n${word()} ${word()} ${word()} ${word()} ${word()} ${word()}, ${word()} ${word()} ${word()}.\n`;
      if (!shape.markup) return prose;

      // Real markdown's tags sit mostly inside fenced code blocks (documentation showing
      // markup rather than using it), and the adapter masks a fence before parse5 reads
      // it. So most markup here is fenced: bytes and tags that cost the parse5 pass time
      // and never yield a reference. About a third is live markup carrying no image.
      // Neither produces a reference; only `shape.refuting` does.
      const draw = random();
      if (draw < 0.55) return prose;
      if (draw < 0.85) {
        return `${prose}\n\`\`\`html\n<div class="${word()}-${unit}">\n  <p>${sentence(word)}</p>\n  <img src="/${word()}-${unit}.png" alt="${word()}">\n</div>\n\`\`\`\n`;
      }
      return `${prose}\n<div class="note-${unit}">\n  <p>${sentence(word)}</p>\n  <a href="#${word()}-${unit}">${word()}</a><br>\n</div>\n`;
    }
    case '.json':
      return `,\n  "${word()}${unit}": { "${word()}": ${unit}, "${word()}": "${word()}-${unit}" }`;
    case '.vue':
      return `<script>export const v${unit} = { ${word()}: ${unit} };</script>`;
    case '.yaml':
      return `${word()}${unit}:\n  ${word()}: ${unit}\n  ${word()}: ${word()}`;
    case '.tsx':
      return [
        '/**',
        ` * ${sentence(word)}`,
        ' *',
        ` * ${sentence(word)}`,
        ' */',
        `export function Part${unit}({ ${word()} }: { ${word()}: string }) {`,
        `  const ${word()}${unit} = ${unit} * 2;`,
        '  return (',
        `    <section className="panel-${unit}">`,
        `      <p>${sentence(word)}</p>`,
        `      <span>{${word()}}</span>`,
        '    </section>',
        '  );',
        '}',
      ].join('\n');
    // Plain JavaScript, without the type annotations the `default` branch writes. Babel
    // rejects those in a `.js` file, and the benchmark would then time failed parses
    // rather than parses.
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return [
        `/** ${sentence(word)} */`,
        `export function helper${unit}(${word()}) {`,
        `  // ${sentence(word)}`,
        `  const ${word()}${unit} = ${word()} * ${unit + 1};`,
        `  return ${word()}${unit} + ${unit};`,
        '}',
      ].join('\n');
    default:
      return [
        `/** ${sentence(word)} */`,
        `export function helper${unit}(${word()}: number): number {`,
        `  // ${sentence(word)}`,
        `  const ${word()}${unit} = ${word()} * ${unit + 1};`,
        `  return ${word()}${unit} + ${unit};`,
        '}',
      ].join('\n');
  }
}

/**
 * A line of prose, for filler that has to add bytes without syntax nodes.
 *
 * Real components get much of their size from comments, prose inside JSX, long strings
 * and blank lines, so filler made only of declarations hands Babel about twice the nodes
 * per KB that real code does. A comment costs bytes and no nodes, and a sentence inside
 * JSX is one `JSXText` node however long it runs, so the filler uses both.
 */
function sentence(word: () => string): string {
  return `${word()} ${word()} ${word()} ${word()} ${word()} ${word()} ${word()} ${word()}`;
}

/** Identifier-safe filler words. Real code is words, not `xxxxx`. */
const WORDS = [
  'value',
  'result',
  'config',
  'handler',
  'render',
  'source',
  'target',
  'buffer',
  'context',
  'element',
  'record',
  'entry',
] as const;

function expandWeights(): string[] {
  const kinds: string[] = [];
  for (const kind of SOURCE_KINDS) {
    for (let index = 0; index < kind.weight; index++) kinds.push(kind.extension);
  }
  return kinds;
}

/**
 * What kind of markdown document this is, drawn once per file.
 *
 * Without documents where skipping the parse5 pass loses a reference, the tree could only
 * ever confirm that the skip is safe. Both rates below are measured on the five
 * validation repositories. They are far apart because most markup in documentation sits
 * inside fenced code blocks, which the adapter masks before parse5 sees it, and the
 * filler reproduces that. See "The benchmark tree" in ARCHITECTURE.md.
 */
export interface MarkdownShape {
  /** This document carries raw HTML: fenced, live, or both. */
  readonly markup: boolean;
  /** This document carries an image reference that only the parse5 pass can find. */
  readonly refuting: boolean;
}

/** Measured: 2,305 of 3,222 markdown documents carry at least one HTML tag. */
const MARKUP_SHARE = 0.715;

/** Measured: 30 of 3,222 would lose a reference if the parse5 pass were skipped. */
const REFUTING_SHARE = 0.01;

function markdownShapeFor(extension: string, random: () => number): MarkdownShape {
  if (extension !== '.md' && extension !== '.mdx') return { markup: false, refuting: false };

  const markup = random() < MARKUP_SHARE;
  const refuting = random() < REFUTING_SHARE;
  // A refuting document carries live markup by definition, so the draw cannot
  // produce the one combination that would make it unreachable.
  return { markup: markup || refuting, refuting };
}

/**
 * One generated file, head plus padding, exactly as the tree writes it.
 *
 * Exported so that `generate.test.ts` proves the refuting class exists by running this
 * code rather than a copy of it, which would prove something about the copy.
 */
export function buildFileText(
  extension: string,
  directory: string,
  images: readonly string[],
  random: () => number,
  unreferenced: readonly string[] = [],
): string {
  const shape = markdownShapeFor(extension, random);
  const body = sourceText(extension, directory, images, random, unreferenced, shape);
  return padTo(body, extension, targetSize(extension, random), random, shape);
}

/** A plausible file of the given kind, referencing a few images. */
function sourceText(
  extension: string,
  directory: string,
  images: readonly string[],
  random: () => number,
  /**
   * Images no adapter-read file references.
   *
   * The unread formats below name some of these, so that the sweep records hits. Without
   * them its measured cost would be the cost of looking without the cost of recording,
   * the half that grows with the answer.
   */
  unreferenced: readonly string[] = [],
  shape: MarkdownShape = { markup: false, refuting: false },
): string {
  const pick = () =>
    images[Math.floor(random() * images.length)] ?? images[0] ?? 'public/img/x.png';
  const pickUnreferenced = () => unreferenced[Math.floor(random() * unreferenced.length)] ?? pick();
  const depth = directory.split('/').length;
  const up = '../'.repeat(depth);

  switch (extension) {
    case '.css':
    case '.scss':
      return [
        `.hero { background: url(${up}${pick()}); }`,
        `.icon { background-image: url("${up}${pick()}"); }`,
        // A preprocessor variable: `dynamic`, and never `broken`.
        '.themed { background: url($themeImage); }',
      ].join('\n');
    case '.html':
      return [
        '<!doctype html><html><body>',
        `  <img src="/${pick()}" alt="a">`,
        `  <img src="${up}${pick()}" alt="b">`,
        '  <!-- <img src="/public/img/commented-out.png"> -->',
        '</body></html>',
      ].join('\n');
    case '.md':
    case '.mdx': {
      const head = ['# Title', '', `![alt](${up}${pick()})`, '', `[link](${up}${pick()})`];
      if (!shape.refuting) return head.join('\n');

      // The refuting input. The Markdown regexes match only `![alt](path)` and
      // `[label]: path`, so the `<img src>` and the `background-image` below are found
      // only by the parse5 pass, and skipping it would lose them. `.md` stamps the tag
      // `md.raw-html`, `.mdx` stamps it `mdx.jsx`, and the style attribute is
      // `md.style-attribute`, so all three HTML-born shapes appear.
      //
      // Outside a fence, because fenced markup is masked before parse5 sees it.
      head.push(
        '',
        `<img src="${up}${pick()}" alt="${extension === '.mdx' ? 'jsx' : 'raw'}">`,
        '',
        `<div style="background-image: url('${up}${pick()}')"></div>`,
      );
      return head.join('\n');
    }
    case '.json':
      // Left open: `padTo` appends `,\n "key": …` members and then closes the brace.
      return `{\n  "icon": "/${pick()}",\n  "name": "thing",\n  "main": "./index.js"`;
    case '.vue':
      // No adapter reads this, so it feeds the sweep rather than the graph, and it names
      // an image nothing else references, so the sweep records a hit.
      return `<template><img src="/${pickUnreferenced()}"></template>`;
    case '.yaml':
      return `image: /${pickUnreferenced()}\ntitle: thing`;
    case '.tsx':
      return [
        `import hero from '${up}${pick()}';`,
        // Alias-shaped and common in real code. The tree declares no alias, so this is
        // `unresolved-alias`.
        "import logo from '@/assets/logo.png';",
        'export const C = () => <img src={hero} alt="" />;',
        `export const D = () => <img src="/${pick()}" alt="" />;`,
      ].join('\n');
    default:
      return [
        `import icon from '${up}${pick()}';`,
        `const url = new URL('${up}${pick()}', import.meta.url);`,
        'export { icon, url };',
      ].join('\n');
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    const { stat } = await import('node:fs/promises');
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
