/**
 * Read what an image *is*, without writing anything.
 *
 * Two of the four audit findings need pixels: `oversized` needs dimensions, and
 * `format opportunities` must be **measured** rather than guessed — the build plan
 * is explicit that a saving we report is a saving we encoded. So the engine needs a
 * decoder, and it needs one that cannot write.
 *
 * `ImageProbe` is a port, injected the same way as the resolver's `exists` and
 * `scan`'s `readFile`. The real implementation is `createSharpProbe`, which lives
 * beside `discover` as one of the three modules allowed to touch a disk; everything
 * that consumes probe results takes the data and stays pure.
 *
 * **The port has two methods, and the split is the whole design.** Measured here on
 * sharp 0.35.4 / libvips 8.18.6:
 *
 * | source | `metadata()` | webp | avif |
 * |---|---|---|---|
 * | 400×300 | 2 ms | 56 ms | 317 ms |
 * | 1200×800 | 1 ms | 370 ms | 2 975 ms |
 * | 2400×1600 | 1 ms | 2 620 ms | 9 026 ms |
 *
 * Reading a header is free and independent of pixel count; encoding is three orders
 * of magnitude dearer and AVIF is roughly eight times WebP. One combined `probe()`
 * would force every caller to pay for both, so dimensions are always affordable and
 * encoding is something a caller asks for by name.
 *
 * Nothing here decides *which* assets deserve an encode — that is the audit's policy
 * and lives in one place. This module measures what it is asked to measure, and says
 * so when it could not.
 */

import { compareStrings, extensionOf } from './paths.js';
import type { Asset } from './types.js';

/** A format we can measure an asset against. */
export type EncodeFormat = 'webp' | 'avif';

/** What a header read tells us. */
export interface ImageMetadata {
  /** Width in pixels, of a single frame. */
  readonly width: number;
  /** Height in pixels, of a single frame. */
  readonly height: number;
  /** Container format as decoded: `png`, `jpeg`, `webp`, `gif`, `svg`, … */
  readonly format: string;
  /** Frames. `1` for a still image; more means animated. */
  readonly pages: number;
}

/**
 * Read-only access to image pixels. Injected; never writes.
 *
 * Both methods reject rather than returning a sentinel, because a caller that
 * ignores the difference between "1×1" and "could not read" would report nonsense.
 * `probeAssets` turns every rejection into a recorded reason.
 */
export interface ImageProbe {
  /**
   * Header-only read.
   *
   * Must report the dimensions of **one frame**, not of every frame stacked
   * together, and must report `pages` so a caller can tell an animation from a
   * still without a second read.
   */
  metadata(path: string): Promise<ImageMetadata>;
  /**
   * Encode into memory and report the byte count. Writes nothing.
   *
   * `animated` must be honoured: encoding a ten-frame GIF without it keeps one
   * frame and reports a saving that is only achievable by destroying the image.
   */
  encodedBytes(input: {
    readonly path: string;
    readonly format: EncodeFormat;
    readonly animated: boolean;
  }): Promise<number>;
}

/** Why a measurement was not taken. Machine-readable so a report can group by it. */
export type ProbeSkipCode =
  /** The header would not decode, so there was nothing to measure. */
  | 'header-unreadable'
  /** The header read, but the encode itself failed. */
  | 'encode-failed'
  /** An SVG: encoding it measures a rasterisation, not a saving. */
  | 'vector'
  /** The asset is already in the format we would convert it to. */
  | 'already-target-format'
  /** Deliberately not measured, to bound how long the audit takes. */
  | 'beyond-encode-cap';

/** A measurement that was not taken, and why. Rule 9 applies to numbers too. */
export interface ProbeSkip {
  /** `metadata`, or the format whose encode was skipped. */
  readonly measurement: 'metadata' | EncodeFormat;
  /** Groupable: a report counts capped assets without matching on prose. */
  readonly code: ProbeSkipCode;
  /** Rendered verbatim in the report. */
  readonly reason: string;
}

/** What one encode measured. */
export interface EncodedSize {
  readonly format: EncodeFormat;
  readonly bytes: number;
}

/** Everything measured about one asset. */
export interface AssetProbe {
  /** The report key: POSIX-relative path, matching `Asset.relative`. */
  readonly relative: string;
  /** `null` when the header could not be read; `skipped` then says why. */
  readonly metadata: ImageMetadata | null;
  /** Measured encodes, sorted by format. Only ever formats that were requested. */
  readonly encoded: readonly EncodedSize[];
  /** Every measurement not taken, with a reason. Never silently empty-handed. */
  readonly skipped: readonly ProbeSkip[];
}

export interface ProbeOptions {
  /** The port. Required — there is no default, so nothing probes by accident. */
  readonly probe: ImageProbe;
  /**
   * Formats to measure each asset against.
   *
   * Required and un-defaulted here, because the default belongs to config rather
   * than to the engine: locked decision 3 makes **webp** the conversion target,
   * with avif opt-in via `--format avif`, and the audit measures the format it
   * would actually convert to. Measuring a format the tool would not produce is
   * work nobody asked for. An empty list measures dimensions only.
   */
  readonly formats: readonly EncodeFormat[];
  /**
   * How many assets to encode at all. Unbounded when absent.
   *
   * **A count, and not a byte threshold or a time budget**, for two reasons that
   * the obvious alternatives fail on. Encode cost scales with *pixel count*, not
   * file size, so a byte threshold bounds nothing on a repository of three
   * thousand large images — which is exactly what §5.1(c)'s "large public
   * directory" requirement guarantees we will meet. And a duration budget would
   * break rule 11: byte-identical output for the same inputs means a slow machine
   * must not measure fewer assets than a fast one.
   *
   * Selection is **largest source first**, ties broken by path, so the choice is
   * a deterministic function of the repository. Everything beyond the cap is
   * reported as unmeasured with `beyond-encode-cap` — silence would read as "no
   * opportunity here", which rule 9 forbids.
   *
   * The cap degrades exactly one of the four audit findings. `dead` and `broken`
   * need no probe at all and `oversized` needs only the header, so the cheap
   * findings stay complete however low this goes. The default belongs in `bench/`
   * (rule 16), not in a guess here.
   */
  readonly maxEncodedAssets?: number;
  /**
   * Assets measured at once. Defaults to 4.
   *
   * Deliberately small: libvips already multithreads inside a single encode, so this
   * pool multiplies an already-parallel workload. Four concurrent encodes measured
   * 3.5× faster than four serial ones on a 12-thread machine, but the right number
   * is a `bench/` question, not a guess — see rule 16.
   */
  readonly concurrency?: number;
}

const DEFAULT_CONCURRENCY = 4;

/**
 * The one format that is an asset but not a raster.
 *
 * Encoding an SVG rasterises it at some arbitrary density, so the resulting byte
 * count answers a question nobody asked: it is not "how much would this asset
 * shrink", it is "how big would a picture of this asset be". SVG is audit-only until
 * an SVGO adapter exists, so the encode is declined *with a reason* rather than
 * quietly producing a misleading number.
 */
const VECTOR_EXTENSION = '.svg';

/**
 * Measure every asset.
 *
 * Never rejects for a bad image. A zero-byte file, a truncated PNG, a text file
 * with a `.png` extension and a file that vanished mid-run all become an
 * `AssetProbe` carrying `metadata: null` and a reason — §5.1(e) requires the run to
 * degrade rather than crash, and rule 9 requires the reason to reach the report.
 */
export async function probeAssets(
  assets: readonly Asset[],
  options: ProbeOptions,
): Promise<AssetProbe[]> {
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const withinCap = assetsWithinCap(assets, options);
  const results: AssetProbe[] = [];

  for (let index = 0; index < assets.length; index += concurrency) {
    const batch = assets.slice(index, index + concurrency);
    // `Promise.all` preserves input order, so the output order is a property of the
    // asset list rather than of which encode happened to finish first (rule 11).
    // The cap changes *which* assets are encoded, never the order they come back in.
    results.push(...(await Promise.all(batch.map((asset) => probeOne(asset, options, withinCap)))));
  }

  return results;
}

/**
 * The assets whose encodes will be attempted: the largest sources, up to the cap.
 *
 * Assets that could never be encoded anyway — a vector, or one already in every
 * requested format — are excluded from the running *before* the cap applies, so
 * they cannot occupy a slot they will not use and quietly turn "the 500 largest"
 * into "some number below 500". That test is by extension, which is all we know
 * before a header is read; a mislabelled file is caught later by `metadata.format`
 * and merely returns its slot unused.
 */
function assetsWithinCap(
  assets: readonly Asset[],
  options: ProbeOptions,
): ReadonlySet<string> | null {
  const cap = options.maxEncodedAssets;
  if (cap === undefined || options.formats.length === 0) return null;

  const eligible = assets.filter((asset) => couldEncode(asset, options.formats));
  if (eligible.length <= cap) return null;

  const ordered = [...eligible].sort(
    // Largest source first, ties broken by path so two runs over the same
    // repository choose the same assets — rule 11 reaches the *selection*, not
    // only the output order.
    (a, b) => b.bytes - a.bytes || compareStrings(a.relative, b.relative),
  );

  return new Set(ordered.slice(0, Math.max(0, cap)).map((asset) => asset.path));
}

/** Whether any requested format could produce a measurement, judged by extension alone. */
function couldEncode(asset: Asset, formats: readonly EncodeFormat[]): boolean {
  const extension = extensionOf(asset.path);
  if (extension === VECTOR_EXTENSION) return false;
  return formats.some((format) => extension !== `.${format}`);
}

async function probeOne(
  asset: Asset,
  options: ProbeOptions,
  withinCap: ReadonlySet<string> | null,
): Promise<AssetProbe> {
  const skipped: ProbeSkip[] = [];

  let metadata: ImageMetadata | null = null;
  try {
    metadata = await options.probe.metadata(asset.path);
  } catch (error) {
    skipped.push({ measurement: 'metadata', code: 'header-unreadable', reason: describe(error) });
  }

  const capped = withinCap !== null && !withinCap.has(asset.path);
  const encoded: EncodedSize[] = [];

  for (const format of [...options.formats].sort()) {
    const skip = encodeSkipReason(asset, metadata, format);
    if (skip !== null) {
      skipped.push({ measurement: format, ...skip });
      continue;
    }

    if (capped) {
      skipped.push({
        measurement: format,
        code: 'beyond-encode-cap',
        reason: `not among the ${options.maxEncodedAssets} largest assets measured (raise --max-encodes to include it)`,
      });
      continue;
    }

    try {
      encoded.push({
        format,
        bytes: await options.probe.encodedBytes({
          path: asset.path,
          format,
          // The measurement has to describe an image equivalent to the original.
          // Without this a ten-frame GIF encodes to a single frame and reports a
          // saving of ~92% that is only achievable by throwing nine frames away.
          animated: (metadata?.pages ?? 1) > 1,
        }),
      });
    } catch (error) {
      skipped.push({ measurement: format, code: 'encode-failed', reason: describe(error) });
    }
  }

  return { relative: asset.relative, metadata, encoded, skipped };
}

/** Why this asset should not be encoded to this format at all, or `null` to measure. */
function encodeSkipReason(
  asset: Asset,
  metadata: ImageMetadata | null,
  format: EncodeFormat,
): Pick<ProbeSkip, 'code' | 'reason'> | null {
  if (metadata === null) {
    return {
      code: 'header-unreadable',
      reason: 'the header could not be read, so there is nothing to encode',
    };
  }
  if (extensionOf(asset.path) === VECTOR_EXTENSION) {
    return {
      code: 'vector',
      reason: 'SVG is a vector: encoding it measures a rasterisation, not a saving',
    };
  }
  if (metadata.format === format)
    return { code: 'already-target-format', reason: `already ${format}` };
  return null;
}

/** A one-line description of a failure, without asserting its shape. */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message.split('\n')[0] ?? error.message;
  return String(error);
}
