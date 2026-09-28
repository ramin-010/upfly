/**
 * The real `ImageProbe`, backed by sharp. It both measures and writes, and is one of the
 * few modules that touch the disk.
 *
 * sharp is imported lazily. It is a native module, and a top-level import would load its
 * binary whenever `upfly-core` is imported, so `upfly audit --no-probe` would fail on a
 * machine whose sharp binary does not load, although it reads no pixels at all.
 */

import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { EncodeFormat, ImageMetadata, ImageProbe } from './probe.js';
import { DEFAULT_ENCODE_QUALITY, MAX_ENCODE_PIXELS, STILL_ONLY_FORMATS } from './probe.js';

/**
 * Build the sharp-backed probe.
 *
 * The quality is fixed here, and the same probe serves `audit` and `optimize`, so the two
 * cannot use different settings. Async because sharp is imported on first use: it rejects
 * when sharp's native binary cannot load, before any image has been read.
 */
export async function createSharpProbe(
  quality: Readonly<Record<EncodeFormat, number>> = DEFAULT_ENCODE_QUALITY,
): Promise<ImageProbe> {
  const { default: sharp } = await import('sharp');

  // libvips caches operations, and a cached operation holds its input file open for the
  // life of the process, so on Windows the process cannot delete a file it has probed and
  // no retry helps. Turned off here rather than by the caller, because a caller who forgets
  // gets a failure that looks like a virus scanner or a flaky disk. What the cache would
  // save is unmeasured: an applied run decodes each source up to three times (header,
  // measurement, written file).
  sharp.cache(false);

  /**
   * Build the output pipeline for one encode.
   *
   * Both encoding methods use it, so a measurement and the file it predicts always share
   * their settings.
   */
  const encoder = (path: string, format: EncodeFormat, animated: boolean, lossless = false) => {
    if (animated && STILL_ONLY_FORMATS.has(format)) {
      throw new Error(
        `${format} is written as a single still image, so an animation cannot be encoded to it without stacking its frames into one picture`,
      );
    }

    // Without `animated`, sharp encodes the first frame alone, and every animated GIF
    // would report a saving only achievable by destroying the animation.
    //
    // `MAX_ENCODE_PIXELS` equals sharp's default `limitInputPixels`, so passing it changes
    // no output. It is passed so that the limit in force stays the one
    // `too-large-to-encode` is computed against, even if sharp's default changes.
    //
    // The encode drops metadata, the EXIF orientation tag with it, so `autoOrient` turns the
    // pixels the way a viewer would; phones store most photos unturned. An embedded colour
    // profile needs nothing here: sharp converts through it to sRGB before dropping it.
    const pipeline = sharp(path, {
      animated,
      autoOrient: true,
      limitInputPixels: MAX_ENCODE_PIXELS,
    });
    switch (format) {
      case 'webp':
        // sharp ignores `quality` when `lossless` is set, so the two are never passed
        // together: a number with no effect would look as if it had one.
        return lossless
          ? pipeline.webp({ lossless: true })
          : pipeline.webp({ quality: quality.webp });
      case 'avif':
        // No lossless AVIF: `avif 75` already holds up on the images lossless helps, and
        // lossless AVIF has not been measured, so it is not offered.
        return pipeline.avif({ quality: quality.avif });
      default: {
        const unhandled: never = format;
        return unhandled;
      }
    }
  };

  return {
    quality,

    async metadata(path: string): Promise<ImageMetadata> {
      // A plain read, not `{ animated: true }`: the animated read reports every frame
      // stacked into one strip, so an oversized-by-dimensions finding would be wrong by
      // the frame count. The plain read gives one frame's size and still reports `pages`.
      const result = await sharp(path).metadata();
      const format = result.format ?? 'unknown';

      return {
        // `autoOrient` holds the size once the EXIF orientation tag is applied, as a viewer
        // shows it; `width` and `height` are the stored size.
        width: result.autoOrient?.width ?? result.width ?? 0,
        height: result.autoOrient?.height ?? result.height ?? 0,
        format,
        // Absent for a still image; present and greater than 1 for an animation. sharp
        // reads an animated PNG as its first frame and reports no pages, so a PNG's count
        // comes from the file.
        pages: format === 'png' ? await pngFrames(path) : (result.pages ?? 1),
      };
    },

    async encodedBytes({ path, format, animated, lossless }): Promise<number> {
      const buffer = await encoder(path, format, animated, lossless).toBuffer();
      return buffer.length;
    },

    async encodeToFile({ path, format, animated, destination, lossless }): Promise<number> {
      // The staged tree mirrors the project, so a destination is often several
      // directories deep in a run directory that did not exist a moment ago. sharp
      // reports a missing directory as "unable to open for write", which reads like a
      // permissions problem, so the port creates it.
      await mkdir(dirname(destination), { recursive: true });
      const { size } = await encoder(path, format, animated, lossless).toFile(destination);
      return size;
    },
  };
}

/**
 * The frame count an animated PNG declares in its `acTL` chunk, or 1 for a still PNG.
 *
 * `acTL` must come before the first `IDAT`, so only the chunk headers up to there are read.
 * See https://wiki.mozilla.org/APNG_Specification.
 */
async function pngFrames(path: string): Promise<number> {
  const file = await open(path, 'r');
  try {
    // A chunk is its length, its type, its data and a checksum: 12 bytes around the data.
    // The first 4 bytes of an `acTL` chunk's data are the frame count.
    const head = Buffer.alloc(12);
    let position = 8;
    for (;;) {
      const { bytesRead } = await file.read(head, 0, head.length, position);
      if (bytesRead < 8) return 1;
      const type = head.toString('latin1', 4, 8);
      if (type === 'acTL') return bytesRead === head.length ? Math.max(1, head.readUInt32BE(8)) : 1;
      if (type === 'IDAT' || type === 'IEND') return 1;
      position += head.length + head.readUInt32BE(0);
    }
  } finally {
    await file.close();
  }
}
