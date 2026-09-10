/**
 * Build the repository the benchmark runs against.
 *
 * The shape is fixed by the performance budget: **10 000 files, 2 000 of them
 * images**. Everything about the tree is derived from a seed, so two runs on two
 * machines measure the same work and a number can be compared to last week's.
 *
 * ⚠️ **RECALIBRATED 2026-09-10 against the three §5.1(c) repositories, because the
 * first version was measuring almost nothing.** Its source files averaged **179
 * bytes**. Measured on the real trees:
 *
 * | | source files | mean | median | p90 | total | depth |
 * |---|---|---|---|---|---|---|
 * | `astro-docs` | 2 681 | 6 666 | 2 346 | 16 771 | 17.9 MB | 5.6 |
 * | `eleventy-docs` | 733 | 2 002 | 294 | 4 408 | 1.5 MB | 2.7 |
 * | `shadcn-ui` | 5 406 | 4 704 | 1 850 | 9 146 | 25.4 MB | 5.2 |
 * | **bench, before** | 7 521 | **179** | **181** | **224** | **1.3 MB** | **2.0** |
 *
 * So the tree had the right *file count* and about **1/30th of the bytes**. Since
 * `scan` is ~87% of the budget and reading is most of that, the benchmark was timing
 * seven thousand file opens against almost no content — which is exactly why
 * `shadcn-ui` cost 5.8 s at 5 814 files where this needed 10 000 for the same wall
 * clock. A gate calibrated on it was rule 16 satisfied in letter and broken in
 * spirit.
 *
 * Three things now come from that table rather than from a guess: the **size
 * distribution** (long-tailed, aimed at a ~1 900 median and ~5 000 mean), the
 * **directory depth** (~5, not 2), and the **extension mix**, blended across the
 * three repositories weighted by file count — `.tsx` and `.mdx` dominate, and the
 * old tree contained no `.mdx` at all.
 *
 * The mix keeps a deliberate minimum of `.css`, `.scss`, `.html`, `.vue` and
 * `.yaml` that the blend alone would have dropped: without them the CSS and HTML
 * adapters go unmeasured and the sweep has nothing unread to search, so its cost
 * would read as zero. That deviation is a choice, not an oversight.
 *
 * **It is generated into the OS temp directory, never into the workspace.** The v2
 * VS Code extension watches every folder named `public` inside the workspace and
 * converts what lands there in place, deleting the original — it destroyed 19
 * fixture images that way. The watcher is scoped to the workspace folder, so a tree
 * in `os.tmpdir()` is invisible to it. An `upfly.config.json` kill switch goes in
 * anyway: the cost is one file, and the failure it prevents is silent.
 *
 * Images are real bytes, because the probe has to decode them. They are generated
 * once per size bucket and then copied — encoding two thousand distinct JPEGs would
 * take longer than the benchmark it exists to feed, and a decoder cannot tell the
 * difference between a file and its copy.
 */

import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

/** Bumped when the tree's shape changes, so an old one is never silently reused. */
const TREE_VERSION = 4;

export const TOTAL_FILES = 10_000;
export const TOTAL_IMAGES = 2_000;

/**
 * The image size mix.
 *
 * Deliberately long-tailed rather than uniform: most repositories are mostly icons
 * with a handful of heavy hero images, and the encode cap selects **largest first**,
 * so a uniform tree would make the cap look like it does nothing.
 */
const BUCKETS = [
  { name: 'icon', width: 64, height: 64, format: 'png', count: 1_400 },
  { name: 'thumb', width: 400, height: 300, format: 'jpeg', count: 450 },
  { name: 'photo', width: 1_200, height: 800, format: 'jpeg', count: 140 },
  { name: 'hero', width: 2_400, height: 1_600, format: 'jpeg', count: 10 },
] as const;

/**
 * Source file sizes, **per extension**, as eleven measured quantiles.
 *
 * ⚠️ A single global distribution was the second calibration error, and it was
 * worse than it looks. Real repositories size files by *kind*: `.tsx` has a 1 718
 * median while `.ts` has 2 482 and `.mdx` 2 861, and the mix is 38% `.tsx`. Applying
 * one curve to all of them gave every `.tsx` file **3.3× too many bytes** — which is
 * why `.tsx` came out as 57% of parse time on the generated tree while real `.tsx`
 * files are the *small* ones.
 *
 * So these are not a model. They are p0, p10 … p90, p99 measured across the three
 * §5.1(c) repositories — 8 813 files — and a draw interpolates between them. A table
 * a reader can check against `notes/validation/` beats a curve that has to be
 * believed.
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
 * `.html` has five instances across all three and `.scss`, `.vue` and `.yaml` none
 * at all — they are here for adapter and sweep coverage, not for realism, and
 * borrowing a neighbouring curve is more honest than inventing one.
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
 * 47% `.json` and 31% `.md`. The first four weights below are that blend; the rest
 * are the coverage floor described in the header.
 */
const SOURCE_KINDS = [
  { extension: '.tsx', weight: 34 },
  { extension: '.mdx', weight: 30 },
  { extension: '.json', weight: 14 },
  { extension: '.ts', weight: 7 },
  { extension: '.md', weight: 3 },
  { extension: '.js', weight: 2 },
  { extension: '.css', weight: 2 },
  // Coverage floor. The measured mix has almost none of these, and without them
  // two adapters go unmeasured and the sweep has nothing unread to search.
  { extension: '.scss', weight: 2 },
  { extension: '.html', weight: 2 },
  { extension: '.vue', weight: 2 },
  { extension: '.yaml', weight: 2 },
] as const;

/** Measured median depth is 5.2–5.6 on the two large repos; the old tree was 2. */
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
 * reuse a stale tree — the trap the WSL sync fell into.
 */
export async function generateTree(options: { fresh?: boolean } = {}): Promise<GeneratedTree> {
  const root = join(tmpdir(), `upfly-bench-v${TREE_VERSION}`);

  if (options.fresh === true) await rm(root, { recursive: true, force: true });
  else if (await exists(join(root, '.upfly-bench-complete'))) {
    return { root, files: TOTAL_FILES, images: TOTAL_IMAGES };
  }

  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });

  // Belt and braces. The tree is outside the workspace already, so the watcher
  // cannot see it — but the cost of being wrong about that is silent corruption.
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
    // One real encode per bucket; the rest are copies. A decoder cannot tell, and
    // two thousand distinct encodes would cost more than the benchmark measures.
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
 * The reference mix is deliberate: most resolve, and a minority land in each of the
 * buckets the resolver has to keep apart, so the benchmark exercises the ladder
 * rather than one rung of it. A slice of images is left unreferenced on purpose —
 * without candidates the sweep does no work and its cost would read as zero.
 */
async function writeSources(root: string, images: readonly string[]): Promise<void> {
  const random = rng(0x0bad_c0de);
  const sources = TOTAL_FILES - images.length - 2; // config + completion marker
  // The last tenth is never referenced, so the sweep has candidates to look for.
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
    const body = sourceText(kind, directory, referenceable, random, unreferenced);
    await writeFile(path, padTo(body, kind, targetSize(kind, random), random));
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

  // The last point is p99, so the top 1% is drawn from the p90–p99 span rather than
  // extrapolated past it: the real maxima are single files (one 1.1 MB `.tsx`) and
  // reproducing them would put a handful of outliers in charge of the median.
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
 * ⚠️ Padding with a comment block would be cheaper to parse than real code, and
 * parsing is a sixth of the budget — so filler that the tokeniser skips would put
 * the bytes back while leaving that sixth understated. Each kind is padded with
 * more of what it already is.
 */
function padTo(body: string, extension: string, target: number, random: () => number): string {
  const parts = [body];
  let size = body.length;
  let unit = 0;

  while (size < target) {
    const chunk = filler(extension, unit, random);
    parts.push(chunk);
    size += chunk.length;
    unit += 1;
  }

  // JSON is emitted with its object left open so that padding can append members;
  // it has to be closed here or 14% of the tree becomes `ADAPTER_PARSE_FAILED` and
  // the benchmark measures the error path instead of the parse path.
  if (extension === '.json') parts.push('}');

  return `${parts.join('\n')}\n`;
}

function filler(extension: string, unit: number, random: () => number): string {
  const word = () => WORDS[Math.floor(random() * WORDS.length)] ?? 'value';

  switch (extension) {
    case '.css':
    case '.scss':
      return `.rule-${unit} { color: #${(unit * 7919) % 1000}; margin: ${unit % 12}px; padding: ${unit % 5}px ${unit % 9}px; }`;
    case '.html':
      return `  <section class="s-${unit}"><h2>${word()} ${word()}</h2><p>${word()} ${word()} ${word()} ${word()}.</p></section>`;
    case '.md':
    case '.mdx':
      return `\n## ${word()} ${word()}\n\n${word()} ${word()} ${word()} ${word()} ${word()} ${word()}, ${word()} ${word()} ${word()}.\n`;
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
 * A line of prose, for filler that has to add **bytes without AST nodes**.
 *
 * ⚠️ This is the third calibration axis, and it was wrong too. Measured, generated
 * `.tsx` came out at **233.7 AST nodes per KB against real code's 120.3** — so even
 * once the byte counts matched, the tree was handing Babel nearly twice the work per
 * byte. Real components are mostly comments, prose inside JSX, long string literals
 * and blank lines; a wall of tiny declarations is not what a repository looks like.
 *
 * A comment costs bytes and no nodes. A sentence inside JSX is one `JSXText` node
 * however long it runs. Both are how real files get their bytes, so both are how
 * this gets its own — and there is no version of this where the tree is finally
 * "representative": there is only the next axis nobody has checked yet.
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

/** A plausible file of the given kind, referencing a few images. */
function sourceText(
  extension: string,
  directory: string,
  images: readonly string[],
  random: () => number,
  /**
   * Images no adapter-read file references.
   *
   * The unread formats below name some of these on purpose. Without that the sweep
   * finds nothing, and its measured cost would be the cost of looking rather than
   * the cost of looking *and* recording — the half that grows with the answer.
   */
  unreferenced: readonly string[] = [],
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
    case '.mdx':
      return ['# Title', '', `![alt](${up}${pick()})`, '', `[link](${up}${pick()})`].join('\n');
    case '.json':
      // Opened rather than closed: `padTo` appends `,\n "key": …` members, so the
      // brace is added by `writeSources` at the end. A malformed JSON file would be
      // an `ADAPTER_PARSE_FAILED` on 14% of the tree and would measure the error
      // path instead of the parse path.
      return `{\n  "icon": "/${pick()}",\n  "name": "thing",\n  "main": "./index.js"`;
    case '.vue':
      // No adapter reads this, so it feeds the sweep rather than the graph — and it
      // names an image nothing else references, so the sweep actually finds
      // something. Measuring a sweep that never records a hit would measure the
      // cost of looking without the cost of finding.
      return `<template><img src="/${pickUnreferenced()}"></template>`;
    case '.yaml':
      return `image: /${pickUnreferenced()}\ntitle: thing`;
    case '.tsx':
      return [
        `import hero from '${up}${pick()}';`,
        // Alias-shaped: `unresolved-alias` until Phase 2, and common in real code.
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
