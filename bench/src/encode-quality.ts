/**
 * Choosing the encode quality by measuring it, on images nobody made for us.
 *
 * Every saving figure this project holds was computed at sharp's defaults, which for
 * AVIF is quality 50. A 95% saving at quality 50 is not a saving, it is a downgrade
 * wearing a saving's clothes, so a number had to be chosen deliberately and written
 * down before any saving may be quoted again.
 *
 * Bytes alone cannot make that choice. Lower quality always wins on bytes, so a
 * byte-only measurement argues for quality 1. What is needed alongside it is some
 * measure of how far the result has moved from the original, and this uses peak
 * signal-to-noise ratio over the decoded pixels.
 *
 * PSNR is not perceptual quality and this file does not pretend otherwise: it cannot
 * tell a blur a viewer forgives from ringing around text that a viewer notices at a
 * glance. What it does do is respond, reproducibly and without an opinion, to how
 * much the pixels changed, which is enough to rule out the qualities that are
 * obviously too low and to say where the returns stop. `assertMetricResponds` exists
 * because a distortion metric that silently returned a constant would look exactly
 * like a flat curve, and a flat curve is what would argue for the lowest quality.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { readdir, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { argv, stdout } from 'node:process';
import sharp from 'sharp';

const VALIDATION_ROOT = 'E:/PERSONAL_PROJECTS/upfly-validation';

const REPOS = ['astro-docs', 'eleventy-docs', 'railsgirls-com', 'scratch-www', 'shadcn-ui'];

const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '_site',
  '.next',
  'out',
  'coverage',
  '__MACOSX',
]);

/** The grid. Below 50 is sharp's own default territory and already ruled out. */
const QUALITIES = [50, 65, 75, 80, 85, 90] as const;

/** How many images to measure. Every encode here costs real time, AVIF most of all. */
const SAMPLE_SIZE = 30;

const CONCURRENCY = 4;

interface Source {
  readonly path: string;
  readonly label: string;
  readonly bytes: number;
  readonly extension: string;
}

interface Measurement {
  readonly label: string;
  readonly extension: string;
  readonly originalBytes: number;
  readonly format: string;
  readonly quality: number | 'lossless';
  readonly encodedBytes: number;
  /** Decibels. Higher means closer to the original; Infinity means identical. */
  readonly psnr: number;
}

async function main(): Promise<void> {
  const sample = await chooseSample();
  stdout.write(`Measuring ${sample.length} images from ${REPOS.length} repositories.\n`);

  await assertMetricResponds(sample);

  const measurements: Measurement[] = [];
  for (let index = 0; index < sample.length; index += CONCURRENCY) {
    const batch = sample.slice(index, index + CONCURRENCY);
    const done = await Promise.all(batch.map(measureOne));
    for (const list of done) measurements.push(...list);
    stdout.write(`  ${Math.min(index + CONCURRENCY, sample.length)}/${sample.length}\n`);
  }

  await writeReport(sample, measurements);
}

/**
 * A deterministic, stratified sample.
 *
 * Sorted by path and taken at an even stride within each group rather than chosen by
 * hand, so the selection is a property of the repositories rather than of which
 * images happened to look interesting. Stratifying by extension keeps photographs
 * and screenshots both represented: a JPEG is already lossy and a PNG usually is not,
 * and they do not behave the same way under a lossy re-encode.
 */
async function chooseSample(): Promise<Source[]> {
  const all: Source[] = [];
  for (const repo of REPOS) all.push(...(await candidatesIn(repo)));
  all.sort((a, b) => a.label.localeCompare(b.label));

  const chosen: Source[] = [];
  for (const extension of ['.png', '.jpg']) {
    const group = all.filter((source) => source.extension === extension);
    const wanted = Math.round(SAMPLE_SIZE / 2);
    const stride = Math.max(1, Math.floor(group.length / wanted));
    for (let index = 0; chosen.length < wanted * (extension === '.png' ? 1 : 2); index += stride) {
      const source = group[index];
      if (source === undefined) break;
      chosen.push(source);
    }
  }
  return chosen;
}

/** Every measurable image in one repository. */
async function candidatesIn(repo: string): Promise<Source[]> {
  const root = join(VALIDATION_ROOT, repo);
  const found: Source[] = [];

  for (const path of await walk(root)) {
    const extension = extname(path).toLowerCase();
    if (extension !== '.png' && extension !== '.jpg' && extension !== '.jpeg') continue;

    const info = await stat(path);
    // Below a few kilobytes the container overhead dominates and the comparison says
    // more about headers than about the encoder.
    if (info.size < 4096) continue;

    found.push({
      path,
      label: `${repo}/${toPosix(relative(root, path))}`,
      bytes: info.size,
      extension: extension === '.jpeg' ? '.jpg' : extension,
    });
  }
  return found;
}

/** Native separators to POSIX, so a label reads the same on every platform. */
function toPosix(path: string): string {
  return path.split(sep).join('/');
}

/**
 * Prove the distortion metric moves before trusting a single number it produces.
 *
 * A metric that always returned the same value would produce a flat curve, and a
 * flat curve says quality costs nothing, which is the exact wrong conclusion. This
 * encodes one image at a deliberately terrible quality and at a good one and insists
 * the numbers are far apart and ordered the right way.
 */
async function assertMetricResponds(sample: readonly Source[]): Promise<void> {
  const subject = sample[0];
  if (subject === undefined) throw new Error('No images were sampled, so nothing can be measured.');

  const bad = await measure(subject, 'webp', 10);
  const good = await measure(subject, 'webp', 95);

  if (!(good.psnr > bad.psnr + 3)) {
    throw new Error(
      `The distortion metric does not respond to quality: q10 scored ${bad.psnr.toFixed(2)} dB and q95 scored ${good.psnr.toFixed(2)} dB on ${subject.label}. Every number below it would be meaningless.`,
    );
  }
  stdout.write(
    `Metric responds: q10 ${bad.psnr.toFixed(1)} dB vs q95 ${good.psnr.toFixed(1)} dB on ${subject.label}.\n`,
  );
}

async function measureOne(source: Source): Promise<Measurement[]> {
  const results: Measurement[] = [];
  for (const quality of QUALITIES) {
    results.push(await measure(source, 'webp', quality));
    results.push(await measure(source, 'avif', quality));
  }
  // Lossless WebP is the option a PNG deserves to be compared against: somebody who
  // saved a screenshot as PNG chose a format that does not throw pixels away, and a
  // lossy replacement is a different product even when it is smaller.
  if (source.extension === '.png') results.push(await measureLossless(source));
  return results;
}

async function measure(
  source: Source,
  format: 'webp' | 'avif',
  quality: number,
): Promise<Measurement> {
  const input = await readFile(source.path);
  const encoded =
    format === 'webp'
      ? await sharp(input).webp({ quality }).toBuffer()
      : await sharp(input).avif({ quality }).toBuffer();

  return {
    label: source.label,
    extension: source.extension,
    originalBytes: source.bytes,
    format,
    quality,
    encodedBytes: encoded.length,
    psnr: await psnr(input, encoded),
  };
}

async function measureLossless(source: Source): Promise<Measurement> {
  const input = await readFile(source.path);
  const encoded = await sharp(input).webp({ lossless: true }).toBuffer();
  return {
    label: source.label,
    extension: source.extension,
    originalBytes: source.bytes,
    format: 'webp-lossless',
    quality: 'lossless',
    encodedBytes: encoded.length,
    psnr: await psnr(input, encoded),
  };
}

/**
 * Peak signal-to-noise ratio between two images, in decibels.
 *
 * Colour is compared premultiplied by alpha, and alpha is compared on its own.
 *
 * ⚠️ The first version compared raw RGBA straight from the decoder and the control
 * caught it: `full-logo-dark.png` scored 31.41 dB at quality 10 and 31.35 dB at
 * quality 95, flat and very slightly inverted. 64,249 of its 94,200 pixels are fully
 * transparent, and the colour stored behind a transparent pixel is arbitrary, so
 * encoders write whatever they like there. The measurement was dominated by noise in
 * pixels nobody can see, and it would have produced a flat curve, which argues that
 * quality costs nothing.
 *
 * Premultiplying weights every colour difference by how visible that pixel is, so a
 * fully transparent pixel contributes nothing however its colour was stored, while
 * damage to the alpha channel itself still registers at full strength.
 */
async function psnr(original: Buffer, encoded: Buffer): Promise<number> {
  const [a, b] = await Promise.all([toRaw(original), toRaw(encoded)]);
  if (a.length !== b.length) {
    throw new Error(`Decoded sizes differ: ${a.length} against ${b.length}.`);
  }

  let squaredError = 0;
  for (let index = 0; index < a.length; index += 4) {
    const alphaA = a[index + 3] as number;
    const alphaB = b[index + 3] as number;

    for (let channel = 0; channel < 3; channel++) {
      const left = ((a[index + channel] as number) * alphaA) / 255;
      const right = ((b[index + channel] as number) * alphaB) / 255;
      squaredError += (left - right) ** 2;
    }
    squaredError += (alphaA - alphaB) ** 2;
  }

  const meanSquared = squaredError / a.length;
  if (meanSquared === 0) return Number.POSITIVE_INFINITY;
  return 10 * Math.log10((255 * 255) / meanSquared);
}

async function toRaw(image: Buffer): Promise<Buffer> {
  return sharp(image).ensureAlpha().raw().toBuffer();
}

async function writeReport(
  sample: readonly Source[],
  measurements: readonly Measurement[],
): Promise<void> {
  const lines: string[] = [
    '# Encode quality, measured',
    '',
    `Generated by \`bench/src/encode-quality.ts\` over **${sample.length} images** sampled`,
    'deterministically from the five validation repositories. Saving is against the original file.',
    'PSNR is peak signal-to-noise ratio over decoded pixels: higher is closer to the original,',
    'and it measures how far the pixels moved rather than whether a viewer would mind.',
    '',
    '| format | quality | median saving | worst saving | median PSNR | worst PSNR | images below 35 dB |',
    '|---|---|---|---|---|---|---|',
  ];

  const groups = new Map<string, Measurement[]>();
  for (const measurement of measurements) {
    const key = `${measurement.format}|${measurement.quality}`;
    const list = groups.get(key) ?? [];
    list.push(measurement);
    groups.set(key, list);
  }

  for (const [key, list] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const [format, quality] = key.split('|');
    const savings = list.map((m) => 1 - m.encodedBytes / m.originalBytes).sort((a, b) => a - b);
    const scores = list.map((m) => m.psnr).sort((a, b) => a - b);
    const below = scores.filter((value) => value < 35).length;

    lines.push(
      `| ${format} | ${quality} | ${percent(median(savings))} | ${percent(savings[0] ?? 0)} | ` +
        `${decibels(median(scores))} | ${decibels(scores[0] ?? 0)} | ${below} of ${list.length} |`,
    );
  }

  lines.push('', '## Every image measured', '');
  lines.push('| image | source | format | quality | saving | PSNR |');
  lines.push('|---|---|---|---|---|---|');
  for (const m of measurements) {
    lines.push(
      `| ${m.label} | ${m.extension} | ${m.format} | ${m.quality} | ` +
        `${percent(1 - m.encodedBytes / m.originalBytes)} | ${decibels(m.psnr)} |`,
    );
  }

  const out = resolve('../../notes/validation/encode-quality.md');
  await writeFile(out, `${lines.join('\n')}\n`, 'utf8');
  stdout.write(`\nWrote ${out}\n`);
}

function median(sorted: readonly number[]): number {
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
    : (sorted[middle] as number);
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function decibels(value: number): string {
  return Number.isFinite(value) ? `${value.toFixed(1)}` : 'lossless';
}

async function walk(directory: string): Promise<string[]> {
  const found: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return found;
  }

  for (const entry of entries) {
    if (SKIP_DIRECTORIES.has(entry)) continue;
    const full = join(directory, entry);
    try {
      const info = await stat(full);
      if (info.isDirectory()) found.push(...(await walk(full)));
      else if (info.isFile()) found.push(full);
    } catch {
      // A path we cannot stat is a path we cannot measure; the sample is large
      // enough that saying so per file would be noise.
    }
  }
  return found;
}

if (argv[1]?.includes('encode-quality')) await main();
