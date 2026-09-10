/**
 * Build the repository the benchmark runs against.
 *
 * The shape is fixed by the performance budget: **10 000 files, 2 000 of them
 * images**. Everything about the tree is derived from a seed, so two runs on two
 * machines measure the same work and a number can be compared to last week's.
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
const TREE_VERSION = 2;

export const TOTAL_FILES = 10_000;
export const TOTAL_IMAGES = 2_000;

/**
 * The size mix.
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

/** Source formats, in the proportions a real project has them. */
const SOURCE_KINDS = [
  { extension: '.tsx', weight: 30 },
  { extension: '.ts', weight: 25 },
  { extension: '.css', weight: 12 },
  { extension: '.scss', weight: 6 },
  { extension: '.html', weight: 8 },
  { extension: '.md', weight: 8 },
  { extension: '.json', weight: 5 },
  // Unclaimed on purpose: without these the sweep has nothing to read, and the
  // rule that decides `dead` against `possibly-dead` would go unmeasured.
  { extension: '.vue', weight: 4 },
  { extension: '.yaml', weight: 2 },
] as const;

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
  let written = 0;

  for (let index = 0; written < sources; index++) {
    const kind = kinds[index % kinds.length] ?? '.ts';
    const directory = `src/module-${Math.floor(index / 40)}`;
    await mkdir(join(root, directory), { recursive: true });

    const path = join(root, directory, `file-${index}${kind}`);
    await writeFile(path, sourceText(kind, directory, referenceable, random, unreferenced));
    written += 1;
  }
}

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
      return [`# Title`, '', `![alt](${up}${pick()})`, '', `[link](${up}${pick()})`].join('\n');
    case '.json':
      return `${JSON.stringify({ icon: `/${pick()}`, name: 'thing', main: './index.js' }, null, 2)}\n`;
    case '.vue':
      // No adapter reads this, so it feeds the sweep rather than the graph — and it
      // names an image nothing else references, so the sweep actually finds
      // something. Measuring a sweep that never records a hit would measure the
      // cost of looking without the cost of finding.
      return `<template><img src="/${pickUnreferenced()}"></template>\n`;
    case '.yaml':
      return `image: /${pickUnreferenced()}\ntitle: thing\n`;
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
