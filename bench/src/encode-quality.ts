/**
 * Measures bytes saved and distortion at a grid of qualities, on images from the five
 * validation repositories, to choose `DEFAULT_ENCODE_QUALITY`.
 *
 * Bytes alone cannot choose: a lower quality always saves more. So each encode is also
 * scored on how far its decoded pixels moved, by PSNR and by SSIM. Neither is perceptual
 * quality, and they fail differently: PSNR is dominated by area, so it misses damaged text
 * on a mostly flat image, which SSIM over textured windows can see. `assertMetricResponds`
 * runs first, because a metric stuck at one value would draw a flat curve, and a flat curve
 * argues for the lowest quality.
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

/** The qualities measured, from sharp's AVIF default of 50 upward. */
const QUALITIES = [50, 65, 75, 80, 85, 90] as const;

/** How many images to measure. Every encode here costs real time, AVIF most of all. */
const SAMPLE_SIZE = 30;

const CONCURRENCY = 4;

/**
 * Which population an image was drawn from.
 *
 * A proportional sample is mostly `railsgirls-com`, which holds most of the corpus's images,
 * and those are sponsor logos and event photographs. The text-heavy cohort is named
 * separately so that screenshots and diagrams are measured at all.
 */
type Cohort = 'proportional' | 'text-heavy';

/**
 * Screenshots, UI captures and labelled diagrams, chosen by looking at them.
 *
 * A list, because a detector fails here without showing it. Ranking images by their share of
 * steep luma gradients puts screenshots near the bottom: a screenshot is mostly flat
 * background, and its text covers a small part of the area. `jamstack-2020-results.png`, white
 * text on coloured fills over thin gridlines, is a hard case, since ringing shows worst at
 * high-contrast edges.
 */
const TEXT_HEAVY: readonly string[] = [
  // Application UI, light and dark: dark mode is a genuinely different artefact profile,
  // since light text on a dark ground rings the other way.
  'shadcn-ui/apps/v4/public/examples/tasks-light.png',
  'shadcn-ui/apps/v4/public/examples/tasks-dark.png',
  'shadcn-ui/apps/v4/public/examples/dashboard-light.png',
  'shadcn-ui/apps/v4/public/examples/dashboard-dark.png',
  'shadcn-ui/apps/v4/public/examples/cards-light.png',
  'shadcn-ui/apps/v4/public/examples/cards-dark.png',
  'shadcn-ui/apps/v4/public/examples/authentication-light.png',
  'shadcn-ui/apps/v4/public/examples/authentication-dark.png',
  'shadcn-ui/apps/v4/public/examples/playground-light.png',
  'shadcn-ui/apps/v4/public/examples/playground-dark.png',
  // Labelled diagrams and charts.
  'eleventy-docs/src/blog/jamstack-2020-results.png',
  'eleventy-docs/src/blog/sevenmilgraph.png',
  'eleventy-docs/src/blog/twomillion.png',
  // An open-graph card: large type over a background, which is what a social preview is.
  'astro-docs/public/default-og-image.png',
];

interface Source {
  readonly path: string;
  readonly label: string;
  readonly bytes: number;
  readonly extension: string;
  readonly cohort: Cohort;
}

interface Measurement {
  readonly label: string;
  readonly extension: string;
  readonly cohort: Cohort;
  readonly originalBytes: number;
  readonly format: string;
  readonly quality: number | 'lossless';
  readonly encodedBytes: number;
  /** Decibels. Higher means closer to the original; Infinity means identical. */
  readonly psnr: number;
  /**
   * Structural similarity, 0 to 1. Higher is closer; 1 means identical.
   *
   * PSNR is a mean of squared pixel differences, so a screenshot that is mostly flat
   * background scores well however badly its text is damaged. SSIM compares local means,
   * variances and covariance in each window, so a window of smeared letterforms loses
   * structure and shows it. It is not perceptual truth either, but it fails differently
   * from PSNR, and where the two disagree is the finding.
   */
  readonly ssim: number;
  /**
   * SSIM over the windows that had content in the original.
   *
   * The figure that can see text. `ssim` above is diluted by flat background, which on a
   * screenshot is most of the image.
   */
  readonly ssimTextured: number;
  /** What share of windows carried content. Context for the figure above. */
  readonly texturedFraction: number;
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
 * Two cohorts: an even stride over every image, and the named text-heavy list.
 *
 * The stride runs over images sorted by path, so the selection is a property of the
 * repositories rather than of which images looked interesting. Splitting it between PNG and
 * JPEG does not make it representative: an extension says how an image is stored, not what
 * is in it, which is why the text-heavy cohort exists.
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

  // Matched against what the walk found, so an entry missing at the pinned commit fails
  // loudly instead of quietly shrinking the cohort every text-heavy figure rests on.
  const byLabel = new Map(all.map((source) => [source.label, source]));
  const missing: string[] = [];
  for (const label of TEXT_HEAVY) {
    const source = byLabel.get(label);
    if (source === undefined) missing.push(label);
    else chosen.push({ ...source, cohort: 'text-heavy' });
  }
  if (missing.length > 0) {
    throw new Error(
      `The text-heavy cohort names ${missing.length} image(s) the corpus does not have at its pinned commits: ${missing.join(', ')}. R47's re-sample cannot be run without them.`,
    );
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
      cohort: 'proportional',
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
  // One image from each cohort. A metric can respond on a logo or photograph and stay flat
  // on a screenshot, so a control that saw only the proportional cohort would vouch for
  // the metric on the images where it was never in doubt.
  const subjects = (['proportional', 'text-heavy'] as const).map((cohort) =>
    sample.find((source) => source.cohort === cohort),
  );
  if (subjects[0] === undefined) {
    throw new Error('No images were sampled, so nothing can be measured.');
  }

  for (const subject of subjects) {
    if (subject === undefined) continue;
    const bad = await measure(subject, 'webp', 10);
    const good = await measure(subject, 'webp', 95);

    if (!(good.psnr > bad.psnr + 3)) {
      throw new Error(
        `PSNR does not respond to quality: q10 scored ${bad.psnr.toFixed(2)} dB and q95 scored ${good.psnr.toFixed(2)} dB on ${subject.label} (${subject.cohort}). Every number below it would be meaningless.`,
      );
    }
    // Compared as distortion (1 - SSIM), and as a ratio. SSIM crowds against 1, so an
    // absolute gap misleads: 0.9987 against 0.9996 is a threefold difference in distortion
    // but only 0.0009 in SSIM.
    const badDistortion = 1 - bad.ssimTextured;
    const goodDistortion = 1 - good.ssimTextured;
    if (!(badDistortion > goodDistortion * 2)) {
      throw new Error(
        `SSIM does not respond to quality: q10 scored ${bad.ssimTextured.toFixed(4)} and q95 scored ${good.ssimTextured.toFixed(4)} on ${subject.label} (${subject.cohort}), so distortion barely moved. Every number below it would be meaningless.`,
      );
    }
    stdout.write(
      `Metrics respond on ${subject.cohort}: PSNR ${bad.psnr.toFixed(1)} to ${good.psnr.toFixed(1)} dB, ` +
        `SSIM(textured) ${bad.ssimTextured.toFixed(4)} to ${good.ssimTextured.toFixed(4)}, ` +
        `${(good.texturedFraction * 100).toFixed(0)}% of windows carry content, on ${subject.label}.\n`,
    );
  }
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
    cohort: source.cohort,
    originalBytes: source.bytes,
    format,
    quality,
    encodedBytes: encoded.length,
    psnr: await psnr(input, encoded),
    ...structure(await ssim(input, encoded)),
  };
}

/** Spread one SSIM result across the three fields a `Measurement` carries. */
function structure(result: SsimResult) {
  return {
    ssim: result.all,
    ssimTextured: result.textured,
    texturedFraction: result.texturedFraction,
  };
}

async function measureLossless(source: Source): Promise<Measurement> {
  const input = await readFile(source.path);
  const encoded = await sharp(input).webp({ lossless: true }).toBuffer();
  return {
    label: source.label,
    extension: source.extension,
    cohort: source.cohort,
    originalBytes: source.bytes,
    format: 'webp-lossless',
    quality: 'lossless',
    encodedBytes: encoded.length,
    psnr: await psnr(input, encoded),
    ...structure(await ssim(input, encoded)),
  };
}

/**
 * Peak signal-to-noise ratio between two images, in decibels.
 *
 * Colour is compared premultiplied by alpha, and alpha on its own. The colour stored behind
 * a fully transparent pixel is arbitrary and encoders write whatever they like there, so
 * raw RGBA would measure noise nobody can see: on a mostly transparent logo that flattens
 * the curve, which argues that quality costs nothing. Premultiplied, a transparent pixel
 * contributes nothing, while damage to the alpha channel still counts in full.
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

/**
 * Luma variance above which an 8x8 window is treated as carrying content.
 *
 * A standard deviation of 4 on a 0 to 255 scale. Low, because the point is to exclude flat
 * windows, not to keep only the busiest: a high threshold would narrow the measurement to
 * the sharpest edges in the image.
 */
const TEXTURE_VARIANCE = 16;

/** SSIM over every window, over the windows with content, and how many those were. */
interface SsimResult {
  readonly all: number;
  readonly textured: number;
  readonly texturedFraction: number;
}

/**
 * Structural similarity over luma premultiplied by alpha (for the reason at `psnr`).
 *
 * The standard formula and stabilising constants for 8-bit data, over disjoint 8x8 windows
 * rather than the original paper's sliding 11x11 Gaussian, which on a large screenshot
 * would be tens of millions of windows per encode. So its values compare with each other,
 * not with published SSIM figures.
 *
 * `textured` averages only the windows with content in the original. Over every window, a
 * mostly flat image (a transparent logo, a screenshot's background) scores near 1 however
 * its few windows of text fare: the area bias that blinds PSNR. Both are reported, and the
 * gap between them shows that bias.
 */
async function ssim(original: Buffer, encoded: Buffer): Promise<SsimResult> {
  const [a, b] = await Promise.all([toLuma(original), toLuma(encoded)]);
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`Decoded sizes differ: ${a.width}x${a.height} against ${b.width}x${b.height}.`);
  }

  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  const WINDOW = 8;

  let total = 0;
  let windows = 0;
  let texturedTotal = 0;
  let texturedWindows = 0;

  for (let top = 0; top + WINDOW <= a.height; top += WINDOW) {
    for (let left = 0; left + WINDOW <= a.width; left += WINDOW) {
      let sumA = 0;
      let sumB = 0;
      for (let y = 0; y < WINDOW; y++) {
        const row = (top + y) * a.width + left;
        for (let x = 0; x < WINDOW; x++) {
          sumA += a.luma[row + x] as number;
          sumB += b.luma[row + x] as number;
        }
      }

      const count = WINDOW * WINDOW;
      const meanA = sumA / count;
      const meanB = sumB / count;

      let varianceA = 0;
      let varianceB = 0;
      let covariance = 0;
      for (let y = 0; y < WINDOW; y++) {
        const row = (top + y) * a.width + left;
        for (let x = 0; x < WINDOW; x++) {
          const deltaA = (a.luma[row + x] as number) - meanA;
          const deltaB = (b.luma[row + x] as number) - meanB;
          varianceA += deltaA * deltaA;
          varianceB += deltaB * deltaB;
          covariance += deltaA * deltaB;
        }
      }
      // Sample variance (n-1), which is what the reference implementation uses.
      const divisor = count - 1;
      varianceA /= divisor;
      varianceB /= divisor;
      covariance /= divisor;

      const score =
        ((2 * meanA * meanB + C1) * (2 * covariance + C2)) /
        ((meanA * meanA + meanB * meanB + C1) * (varianceA + varianceB + C2));
      total += score;
      windows++;

      // Judged on the original alone, so the same windows are averaged at every quality.
      // Judged on the encode, a lower quality could flatten a window out of the average and
      // score better for destroying more.
      if (varianceA > TEXTURE_VARIANCE) {
        texturedTotal += score;
        texturedWindows++;
      }
    }
  }

  // An image smaller than one window has no structure to compare; say so rather than
  // returning a 0 that would read as "completely different".
  return {
    all: windows === 0 ? Number.NaN : total / windows,
    textured: texturedWindows === 0 ? Number.NaN : texturedTotal / texturedWindows,
    texturedFraction: windows === 0 ? 0 : texturedWindows / windows,
  };
}

/** Luma premultiplied by alpha, with the dimensions SSIM needs to walk it. */
async function toLuma(
  image: Buffer,
): Promise<{ luma: Float32Array; width: number; height: number }> {
  const { data, info } = await sharp(image)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const luma = new Float32Array(info.width * info.height);
  for (let index = 0; index < luma.length; index++) {
    const offset = index * 4;
    const alpha = (data[offset + 3] as number) / 255;
    luma[index] =
      (0.299 * (data[offset] as number) +
        0.587 * (data[offset + 1] as number) +
        0.114 * (data[offset + 2] as number)) *
      alpha;
  }

  return { luma, width: info.width, height: info.height };
}

async function writeReport(
  sample: readonly Source[],
  measurements: readonly Measurement[],
): Promise<void> {
  const proportional = sample.filter((source) => source.cohort === 'proportional').length;
  const textHeavy = sample.filter((source) => source.cohort === 'text-heavy').length;

  const lines: string[] = [
    '# Encode quality, measured',
    '',
    `Generated by \`bench/src/encode-quality.ts\` over **${sample.length} images**:`,
    `**${proportional} proportional** (deterministic stride over all five repositories) and`,
    `**${textHeavy} text-heavy** (screenshots, UI captures and labelled diagrams, named in`,
    '`TEXT_HEAVY` and verified by looking at them). Saving is against the original file.',
    '',
    'Two distortion metrics, because R47 ruled that one of them is blind to the class this',
    're-sample exists for. **PSNR** is a mean over squared pixel differences, so it is',
    'dominated by area: a screenshot that is mostly flat background scores well however',
    'badly the text is mangled. **SSIM** compares local structure in 8x8 windows, so a',
    'window of smeared letterforms loses structure and says so. Neither is perceptual',
    'truth. **Where they disagree is the finding.**',
    '',
  ];

  const groups = new Map<string, Measurement[]>();
  for (const measurement of measurements) {
    const key = `${measurement.cohort}|${measurement.format}|${measurement.quality}`;
    const list = groups.get(key) ?? [];
    list.push(measurement);
    groups.set(key, list);
  }

  for (const cohort of ['proportional', 'text-heavy'] as const) {
    lines.push(
      `## ${cohort === 'text-heavy' ? 'Text-heavy cohort — the one R47 was raised about' : 'Proportional cohort'}`,
      '',
      '| format | quality | median saving | worst saving | median PSNR | worst PSNR | median SSIM (textured) | worst SSIM (textured) | median SSIM (all windows) | below 35 dB |',
      '|---|---|---|---|---|---|---|---|---|---|',
    );

    for (const [key, list] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      const [group, format, quality] = key.split('|');
      if (group !== cohort) continue;
      const savings = list.map((m) => 1 - m.encodedBytes / m.originalBytes).sort((a, b) => a - b);
      const scores = list.map((m) => m.psnr).sort((a, b) => a - b);
      const diluted = list.map((m) => m.ssim).sort((a, b) => a - b);
      const structure = list.map((m) => m.ssimTextured).sort((a, b) => a - b);
      const below = scores.filter((value) => value < 35).length;

      lines.push(
        `| ${format} | ${quality} | ${percent(median(savings))} | ${percent(savings[0] ?? 0)} | ` +
          `${decibels(median(scores))} | ${decibels(scores[0] ?? 0)} | ` +
          `${ratio(median(structure))} | ${ratio(structure[0] ?? 0)} | ${ratio(median(diluted))} | ${below} of ${list.length} |`,
      );
    }
    lines.push('');
  }

  lines.push('## Every image measured', '');
  lines.push(
    '| image | source | cohort | format | quality | saving | PSNR | SSIM (textured) | SSIM (all) | textured windows |',
  );
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const m of measurements) {
    lines.push(
      `| ${m.label} | ${m.extension} | ${m.cohort} | ${m.format} | ${m.quality} | ` +
        `${percent(1 - m.encodedBytes / m.originalBytes)} | ${decibels(m.psnr)} | ` +
        `${ratio(m.ssimTextured)} | ${ratio(m.ssim)} | ${percent(m.texturedFraction)} |`,
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

/** SSIM to four places: the differences that matter here are in the third and fourth. */
function ratio(value: number): string {
  return Number.isNaN(value) ? 'n/a' : value.toFixed(4);
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
