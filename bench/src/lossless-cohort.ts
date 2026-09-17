/**
 * R47's cohort, widened from 14 images to every raster image in the corpus.
 *
 * 🔴 **Why this exists.** R47 ruled that a text-heavy image should go to lossless WebP —
 * 29.3% saving at perfect fidelity against webp 80's 1.1% — and then deliberately did
 * **not** build it, because the evidence was one hand-picked cohort of 14 and *"a default
 * changed on a thin sample is exactly how R47 started."* This is the widening.
 *
 * ✅ **AND IT NEEDS NO CLASSIFIER, WHICH IS THE POINT.** The obvious build is *"detect
 * text-heavy images, then choose lossless for them"*, and detection is where this would
 * get expensive and arguable. It is not necessary. **Lossless is exact by definition, so
 * whenever it produces fewer bytes than the lossy encode it is better on BOTH axes and
 * there is nothing left to weigh.** The decision is a byte comparison, per image, and the
 * measurement is the decision. R47's *per image, not per run* falls straight out of that.
 *
 * 🔴 **AND IT NEEDS NO PERCEPTUAL METRIC, WHICH MATTERS MORE.** PSNR inverted this exact
 * question once — it rated text-heavy images *higher* at every quality and would have led
 * a chat to LOWER quality for screenshots. A rule that compares byte counts between an
 * exact encode and a lossy one never consults a perceptual metric at all, so it cannot be
 * fooled by one. That is a stronger guarantee than picking a better metric would be.
 *
 * ⚠️ **What this measures and what it does not.** It measures which encode is smaller. It
 * does not measure whether the lossy encode was acceptable — that is what `avif 75`'s
 * SSIM evidence already covers and is not reopened here.
 *
 * **Writes nothing.** Every encode stays a Buffer in memory: no output directory, no
 * temporary files, nothing inside `upfly-validation/` (R52), and nothing anywhere near a
 * `public/` folder the shipped v2 extension still watches.
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

/** The lossy default R47 left standing for everything that is not text-heavy. */
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
  // R86: a throw is a third outcome. An animated GIF, a CMYK JPEG or a truncated file
  // will throw here, and a silent skip would shrink the cohort invisibly — which is the
  // exact failure mode this whole exercise is correcting.
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

  // 🔴 The `.gif` row above is WITHDRAWN and says so on the page, because a number that
  // is only wrong in a footnote gets quoted from the table. This file calls sharp
  // without `animated: true`, and 26 of the corpus's 78 GIFs have more than one page —
  // so for those the comparison is between two FIRST-FRAME encodes, neither of which is
  // the file. Fixing it means teaching this instrument about animation, which is a
  // different measurement; the ruling it feeds (R129) does not rest on GIFs.
  if (rows.some((row) => row.source === '.gif')) {
    stdout.write(
      '\n  ⚠️ the .gif row is WITHDRAWN: 26 of 78 corpus GIFs are animated and this\n     instrument encodes first frames only. Do not quote it. The other rows stand.\n',
    );
  }

  // 🔴 The number the ruling turns on: what does "take the smaller" buy over today's
  // fixed lossy default, across the WHOLE corpus rather than the class it helps?
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

  // 🔴 Is there a CHEAP TRIGGER? "Encode both and keep the smaller" pays for a second
  // encode on every image, and lossless measures at 1.30x the lossy one — so the rule as
  // stated costs ~2.3x today's encode time. R47's own finding suggests a trigger: webp 80
  // on a text-heavy image saves ~1.1% or grows the file, so the images lossless rescues
  // should be the ones the LOSSY encode already did badly on. If that holds, the second
  // encode can be spent only where it can pay, and the rule gets most of its benefit for
  // a fraction of the cost. If it does not hold, there is no trigger and the honest
  // version is the expensive one — which is why this is measured rather than assumed.
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

  // ⚠️ The honest counterweight: images where BOTH encodes are larger than the source.
  // The planner already drops those, so they are not a risk — but leaving them out of
  // the denominator above would overstate what the corpus has to gain.
  const neither = rows.filter(
    (row) => row.lossyBytes >= row.originalBytes && row.losslessBytes >= row.originalBytes,
  );
  stdout.write(
    `\n  images where NEITHER encode beats the original : ${neither.length} (planner already drops these)\n\n`,
  );
}

await main();
