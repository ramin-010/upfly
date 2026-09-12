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

import { compareStrings, extensionOf, isVectorExtension } from './paths.js';
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
   * The quality each format is encoded at, by this probe.
   *
   * Here rather than on `ProbeOptions` because the same object both measures and
   * writes. `audit` reports what this probe measured and `optimize` writes what this
   * probe encodes, so there is no second setting for them to drift apart on: if the
   * number is wrong, both are wrong together, which is the honest failure rather
   * than the one where audit advertises a product optimize does not ship.
   */
  readonly quality: Readonly<Record<EncodeFormat, number>>;
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
  /**
   * Encode to a file instead of to a byte count, and report the bytes written.
   *
   * The writing half of the same port, so the encode `optimize` performs is built by
   * the same code that built the one `audit` measured. Anything that has to be got
   * right once - the plain metadata read, honouring `animated`, the quality above -
   * is got right for both at the same time.
   */
  encodeToFile(input: {
    readonly path: string;
    readonly format: EncodeFormat;
    readonly animated: boolean;
    readonly destination: string;
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
  /**
   * Rendered verbatim in the report, and written here rather than quoted from
   * anywhere else.
   *
   * It used to be the imaging library's own error text for the two failure codes,
   * which broke the promise that the same inputs produce a byte-identical report.
   * Reading four corrupt SVGs 160 times gave the full libvips message 114 times and a
   * truncated one 46, so both the entry and the sort order changed between runs of an
   * unchanged repository. The library's wording is also not ours to put in front of a
   * user: it is free to change between versions, and it describes libvips rather than
   * describing what Upfly did.
   *
   * The underlying text is not lost. It goes to `ProbeOptions.onDiagnostic`, which is
   * a channel nothing deterministic reads.
   */
  readonly reason: string;
}

/**
 * What a third-party imaging library said, on its way somewhere that is not a report.
 *
 * Deliberately not a field on `ProbeSkip`. A field would sit inside the value the
 * report is built from, and keeping it out of the output would then be a rule somebody
 * has to keep remembering. There is no field, so there is nothing for a renderer to
 * print or for a sort to key on, which is a property of the shape rather than of
 * anyone's care.
 */
export interface ProbeDiagnostic {
  /** POSIX-relative path of the asset being measured. */
  readonly asset: string;
  readonly measurement: 'metadata' | EncodeFormat;
  readonly code: Extract<ProbeSkipCode, 'header-unreadable' | 'encode-failed'>;
  /** Verbatim from the library. Unstable between runs, and never a report's business. */
  readonly detail: string;
}

/** What one encode measured. */
export interface EncodedSize {
  readonly format: EncodeFormat;
  readonly bytes: number;
  /**
   * The quality this byte count was produced at.
   *
   * Carried on the measurement rather than looked up beside it, so a saving cannot
   * be written down anywhere without the setting that produced it. A 95% saving at
   * quality 50 and a 44% saving at quality 90 are both true and describe different
   * products, so the number alone does not mean anything.
   */
  readonly quality: number;
}

/**
 * The quality each format is encoded at, chosen by measurement.
 *
 * See notes/validation/encode-quality.md for the run these came from: 30 images
 * sampled deterministically from the five validation repositories, scored on both
 * bytes saved and how far the decoded pixels moved from the original.
 *
 * webp 80 is the highest setting in the measured grid at which no sampled image grew,
 * and it holds every lossless source above 36 dB. Raising it does not rescue the two
 * worst cases, which are already-lossy JPEGs sitting near 34 dB whatever we do; it
 * only taxes the other 28 images, costing 10 points of median saving between 80 and
 * 90 to buy 1 dB on a case that was never ours to fix.
 *
 * avif 75 rather than 80, because AVIF is a more efficient encoder and the same
 * number does not mean the same thing on both scales. At 75 it clears every sampled
 * image of the 35 dB mark with room to spare while still saving about as much as webp
 * does at 80.
 */
export const DEFAULT_ENCODE_QUALITY: Readonly<Record<EncodeFormat, number>> = Object.freeze({
  webp: 80,
  avif: 75,
});

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
   * Two CLI spellings reach this one option: `--max-encodes <n>` sets it, and
   * `--probe-all` clears it. The report points at `--probe-all`, because that is
   * the name a user needs at the moment they notice a number is missing.
   *
   * The cap degrades exactly one of the four audit findings. `dead` and `broken`
   * need no probe at all and `oversized` needs only the header, so the cheap
   * findings stay complete however low this goes. The default belongs in `bench/`
   * (rule 16), not in a guess here.
   */
  readonly maxEncodedAssets?: number;
  /**
   * Assets to measure whatever the cap says.
   *
   * R35 requires every asset a pattern reference could match to be measured. A
   * pattern is one edit covering N assets, so rewriting it is only safe if all N
   * convert alike — which means an unmeasured target does not cost detail, it makes
   * the condition impossible to establish and the pattern permanently undecidable. A
   * cap that limits what we report is a convenience; a cap that limits what we can
   * prove is a correctness bug.
   *
   * ⚠️ `Asset` objects rather than paths, and that is the whole point of the type.
   * The cap is keyed on `asset.path`, which is absolute, while much of the planner
   * speaks in project-relative paths; a set of bare strings here would line up with
   * the probe by convention alone, and the day either side changed convention every
   * pattern would become undecidable in total silence. Taking the objects means
   * there is no string to be the wrong kind of string.
   */
  readonly alwaysMeasure?: readonly Asset[];
  /**
   * Assets measured at once. Defaults to 4.
   *
   * Deliberately small: libvips already multithreads inside a single encode, so this
   * pool multiplies an already-parallel workload. Four concurrent encodes measured
   * 3.5× faster than four serial ones on a 12-thread machine, but the right number
   * is a `bench/` question, not a guess — see rule 16.
   */
  readonly concurrency?: number;
  /**
   * Where a failing library's own words go, when a caller wants them.
   *
   * Absent by default, and an absent sink means the text is dropped rather than
   * stored: a caller who has nowhere to put it does not silently acquire an unstable
   * string. What Upfly concluded is in the skip's `code` and `reason` either way, so
   * nothing a report needs depends on anyone passing this.
   *
   * Called during measurement, so an implementation that throws would fail the probe
   * of an asset that had already failed for a different reason. Callers append to a
   * list or write a line; they do not do work here.
   */
  readonly onDiagnostic?: (diagnostic: ProbeDiagnostic) => void;
}

const DEFAULT_CONCURRENCY = 4;

/**
 * What the report says when a measurement failed, by the code that classifies it.
 *
 * One sentence per code, written once, so two runs of an unchanged repository produce
 * the same bytes. The library's text that used to stand here is not stable enough to
 * put in an artefact that rule 11 is a promise about.
 */
const FAILURE_REASON: Record<'header-unreadable' | 'encode-failed', string> = {
  'header-unreadable':
    'the image header would not decode, so nothing about this image could be measured',
  'encode-failed': 'the image decoded but re-encoding it failed, so there is no size to compare',
};

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

  // Exempt before the cap is applied rather than added back afterwards: added back,
  // they would take slots from the largest assets and quietly turn "the 500 largest"
  // into some smaller number. Exempted, the cap still means what it says and these
  // sit outside it.
  const exempt = new Set((options.alwaysMeasure ?? []).map((asset) => asset.path));
  const ordered = [...eligible]
    .filter((asset) => !exempt.has(asset.path))
    .sort(
      // Largest source first, ties broken by path so two runs over the same
      // repository choose the same assets — rule 11 reaches the *selection*, not
      // only the output order.
      (a, b) => b.bytes - a.bytes || compareStrings(a.relative, b.relative),
    );

  return new Set([...exempt, ...ordered.slice(0, Math.max(0, cap)).map((asset) => asset.path)]);
}

/** Whether any requested format could produce a measurement, judged by extension alone. */
function couldEncode(asset: Asset, formats: readonly EncodeFormat[]): boolean {
  const extension = extensionOf(asset.path);
  if (isVectorExtension(extension)) return false;
  return formats.some((format) => extension !== `.${format}`);
}

async function probeOne(
  asset: Asset,
  options: ProbeOptions,
  withinCap: ReadonlySet<string> | null,
): Promise<AssetProbe> {
  const skipped: ProbeSkip[] = [];

  const fail = (
    measurement: 'metadata' | EncodeFormat,
    code: keyof typeof FAILURE_REASON,
    error: unknown,
  ): void => {
    skipped.push({ measurement, code, reason: FAILURE_REASON[code] });
    options.onDiagnostic?.({ asset: asset.relative, measurement, code, detail: describe(error) });
  };

  let metadata: ImageMetadata | null = null;
  try {
    metadata = await options.probe.metadata(asset.path);
  } catch (error) {
    fail('metadata', 'header-unreadable', error);
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
        // Names `--probe-all` rather than `--max-encodes`: both exist, but this
        // string is what a user meets at the moment they want the missing number,
        // and a discoverable name matters more there than orthogonality does.
        reason: `not among the ${options.maxEncodedAssets} largest assets measured (run with --probe-all to measure the rest)`,
      });
      continue;
    }

    try {
      encoded.push({
        format,
        quality: options.probe.quality[format],
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
      fail(format, 'encode-failed', error);
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
  if (isVectorExtension(extensionOf(asset.path))) {
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
