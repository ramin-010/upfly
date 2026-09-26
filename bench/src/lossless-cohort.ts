/**
 * Compares lossless WebP with webp 80 on every raster image in the validation corpus.
 *
 * A lossless encode is exact, so when it is also smaller it is better on both counts, and
 * the choice needs neither a classifier for text-heavy images nor a perceptual metric. This
 * measures only which encode is smaller, not whether the lossy one looks acceptable. See
 * "Lossless WebP for PNG sources" in ARCHITECTURE.md.
 *
 * Writes nothing: every encode stays in memory, so a run cannot change the pinned corpus.
 *
 * Usage:
 *   pnpm --filter upfly-bench run lossless-cohort
 *   pnpm --filter upfly-bench run lossless-cohort -- --repo=railsgirls-com --limit=50
 */

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { argv, stdout } from 'node:process';
import sharp from 'sharp';
import { type Adapter, defaultAdapters, discover } from 'upfly-core';
import { REPOS, VALIDATION_ROOT } from './repos.js';

const ADAPTERS: readonly Adapter[] = defaultAdapters;

/** The lossy setting lossless competes with: webp's default, `DEFAULT_ENCODE_QUALITY.webp`. */
const LOSSY_QUALITY = 80;

/** Sources sharp will re-encode. `.svg` is never converted, so it is not a subject. */
const RASTER = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.tiff']);

interface Row {
  readonly repo: string;
  readonly relative: string;
  readonly source: string;
  readonly originalBytes: number;
  readonly lossyBytes: number;
  readonly losslessBytes: number;
  /** Positive means smaller than the original. */
  readonly lossySaving: number;
  readonly losslessSaving: number;
  /** The decision this measurement supports, taken on bytes alone. */
  readonly losslessWins: boolean;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

async function main(): Promise<void> {
  const only = argv.find((a) => a.startsWith('--repo='))?.slice('--repo='.length);
  const limit = Number(argv.find((a) => a.startsWith('--limit='))?.slice('--limit='.length) ?? 0);

  const subjects = REPOS.filter(
    (repo) => repo.unconfigured !== true && (only === undefined || repo.name === only),
  );

  const rows: Row[] = [];
  // A throw is a third outcome, counted rather than skipped: a file sharp cannot decode,
  // such as a truncated one, would otherwise shrink the cohort unseen.
  const threw: { repo: string; relative: string; why: string }[] = [];

  for (const repo of subjects) {
    const root = `${VALIDATION_ROOT}/${repo.name}`;
    const found = await discover({ root, adapters: ADAPTERS });
    const images = found.assets.filter((asset) =>
      RASTER.has(extname(asset.relative).toLowerCase()),
    );
    const cohort = limit > 0 ? images.slice(0, limit) : images;

    stdout.write(`  ${repo.name}: ${cohort.length} raster images\n`);

    for (const asset of cohort) {
      try {
        const input = await readFile(asset.path);
        const [lossy, lossless] = await Promise.all([
          sharp(input).webp({ quality: LOSSY_QUALITY }).toBuffer(),
          sharp(input).webp({ lossless: true }).toBuffer(),
        ]);

        rows.push({
          repo: repo.name,
          relative: asset.relative,
          source: extname(asset.relative).toLowerCase(),
          originalBytes: input.length,
          lossyBytes: lossy.length,
          losslessBytes: lossless.length,
          lossySaving: (input.length - lossy.length) / input.length,
          losslessSaving: (input.length - lossless.length) / input.length,
          losslessWins: lossless.length < lossy.length,
        });
      } catch (error) {
        threw.push({
          repo: repo.name,
          relative: asset.relative,
          why: error instanceof Error ? error.message.slice(0, 60) : 'unknown',
        });
      }
    }
  }

  stdout.write(`\n${'='.repeat(74)}\nR47's cohort, widened\n\n`);
  stdout.write(`  images measured : ${rows.length}\n`);
  stdout.write(`  threw (R86)     : ${threw.length}\n`);
  for (const failure of threw.slice(0, 5)) {
    stdout.write(`      ${failure.repo}/${failure.relative} — ${failure.why}\n`);
  }

  const wins = rows.filter((row) => row.losslessWins);
  stdout.write(
    `\n  🔴 lossless produces FEWER BYTES than webp ${LOSSY_QUALITY} : ${wins.length} of ${rows.length} (${pct(wins.length / Math.max(1, rows.length))})\n`,
  );
  stdout.write(
    `     on those images it beats the lossy encode by  : ${pct(median(wins.map((r) => (r.lossyBytes - r.losslessBytes) / r.lossyBytes)))} median\n`,
  );

  stdout.write('\n  by source format\n');
  stdout.write(
    '    ext     n   lossless wins   lossy saving (med)   lossless saving (med)   best of both\n',
  );
  const formats = [...new Set(rows.map((row) => row.source))].sort();
  for (const format of formats) {
    const group = rows.filter((row) => row.source === format);
    const groupWins = group.filter((row) => row.losslessWins);
    const best = group.map((row) => Math.max(row.lossySaving, row.losslessSaving));
    stdout.write(
      `    ${format.padEnd(6)} ${String(group.length).padStart(4)} ${`${groupWins.length}/${group.length}`.padStart(13)} ${pct(median(group.map((r) => r.lossySaving))).padStart(20)} ${pct(median(group.map((r) => r.losslessSaving))).padStart(23)} ${pct(median(best)).padStart(14)}\n`,
    );
  }

  // The `.gif` row is withdrawn in the output, beside the table it would be quoted from.
  // sharp is called without `animated: true`, so an animated GIF is compared as two
  // first-frame encodes, neither of which is the file. The probe tries lossless for PNG
  // sources only, so no decision rests on this row.
  if (rows.some((row) => row.source === '.gif')) {
    stdout.write(
      '\n  ⚠️ the .gif row is WITHDRAWN: 26 of 78 corpus GIFs are animated and this\n     instrument encodes first frames only. Do not quote it. The other rows stand.\n',
    );
  }

  // What keeping the smaller encode saves over always using webp 80, across the whole
  // corpus rather than only the images it helps.
  const today = rows.reduce((sum, row) => sum + row.lossyBytes, 0);
  const proposed = rows.reduce((sum, row) => sum + Math.min(row.lossyBytes, row.losslessBytes), 0);
  const original = rows.reduce((sum, row) => sum + row.originalBytes, 0);

  stdout.write(`\n  corpus totals, all ${rows.length} images\n`);
  stdout.write(`    original                       : ${(original / 1048576).toFixed(1)} MB\n`);
  stdout.write(
    `    today — webp ${LOSSY_QUALITY} always          : ${(today / 1048576).toFixed(1)} MB  (${pct((original - today) / original)} saved)\n`,
  );
  stdout.write(
    `    proposed — smaller of the two  : ${(proposed / 1048576).toFixed(1)} MB  (${pct((original - proposed) / original)} saved)\n`,
  );
  stdout.write(
    `    🔴 what the rule actually buys : ${pct((today - proposed) / today)} beyond today's default\n`,
  );

  // The bands below look for a cheap trigger. Encoding both costs a second encode on every
  // image, and a lossless encode costs about 1.3 times a lossy one. webp 80 saves little on
  // a text-heavy image, or grows it, so if lossless wins cluster where the lossy saving was
  // poor, the second encode could be spent only there.
  stdout.write('  do the lossless wins concentrate where the LOSSY encode did badly?\n');
  stdout.write('    lossy saving band     images   lossless wins   share\n');
  const bands: [string, (s: number) => boolean][] = [
    ['grew the file (<0%)', (s) => s < 0],
    ['0-10%', (s) => s >= 0 && s < 0.1],
    ['10-25%', (s) => s >= 0.1 && s < 0.25],
    ['25-50%', (s) => s >= 0.25 && s < 0.5],
    ['50-75%', (s) => s >= 0.5 && s < 0.75],
    ['75%+', (s) => s >= 0.75],
  ];
  for (const [label, test] of bands) {
    const group = rows.filter((row) => test(row.lossySaving));
    if (group.length === 0) continue;
    const groupWins = group.filter((row) => row.losslessWins).length;
    stdout.write(
      `    ${label.padEnd(20)} ${String(group.length).padStart(7)} ${String(groupWins).padStart(15)} ${pct(groupWins / group.length).padStart(8)}\n`,
    );
  }

  // Images where both encodes are larger than the source. The planner drops these, so they
  // are no risk, but they stay in the totals above: leaving them out would overstate what
  // the corpus has to gain.
  const neither = rows.filter(
    (row) => row.lossyBytes >= row.originalBytes && row.losslessBytes >= row.originalBytes,
  );
  stdout.write(
    `\n  images where NEITHER encode beats the original : ${neither.length} (planner already drops these)\n\n`,
  );
}

await main();
