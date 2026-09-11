/**
 * The real `ImageProbe`, backed by sharp. It both measures and writes.
 *
 * One of the small number of modules allowed to touch a disk, alongside `discover`
 * and the transaction's file store.
 *
 * sharp is imported lazily on purpose. It is a native module, and v2's worst bug was
 * a native module built for one platform and broken everywhere else for months. A
 * top-level import would load the binary the moment anything in `upfly-core` is
 * imported, so `upfly audit --no-probe` would fail on a machine with a mismatched
 * binary even though it needs no pixels at all. Deferring the import to the moment
 * somebody asks for a probe keeps that escape hatch real.
 */

import type { EncodeFormat, ImageMetadata, ImageProbe } from './probe.js';
import { DEFAULT_ENCODE_QUALITY } from './probe.js';

/**
 * Build the sharp-backed probe.
 *
 * The quality is fixed when the probe is built, and the same object then serves both
 * `audit` and `optimize`. That is what makes them unable to disagree: there is one
 * setting, held in one place, and neither command carries its own.
 *
 * Async because of the lazy import. The rejection is worth catching: on a broken
 * native install this is where the user finds out, and it is a much better place than
 * halfway through an audit.
 */
export async function createSharpProbe(
  quality: Readonly<Record<EncodeFormat, number>> = DEFAULT_ENCODE_QUALITY,
): Promise<ImageProbe> {
  const { default: sharp } = await import('sharp');

  /**
   * Build the output pipeline for one encode.
   *
   * Both methods below go through here, so a measurement and the file it predicts
   * are produced by the same settings by construction rather than by two call sites
   * being kept in step.
   */
  const encoder = (path: string, format: EncodeFormat, animated: boolean) => {
    // `{ animated }` is not optional in spirit. Without it sharp keeps the first
    // frame and nothing else: a ten-frame fixture encodes to 616 bytes instead of
    // 8370, so every animated GIF would report a saving only achievable by
    // destroying the animation.
    const pipeline = sharp(path, { animated });
    switch (format) {
      case 'webp':
        return pipeline.webp({ quality: quality.webp });
      case 'avif':
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
      // Deliberately a plain read, not `{ animated: true }`. For an animated GIF the
      // animated read reports every frame stacked into one strip - sharp's own
      // 370x285 ten-frame fixture comes back as 370x2850 - which would make an
      // "oversized by dimensions" finding wrong by a factor of ten. The plain read
      // gives one frame's dimensions and still reports `pages`, so it answers both
      // questions in one pass.
      const result = await sharp(path).metadata();

      return {
        width: result.width ?? 0,
        height: result.height ?? 0,
        format: result.format ?? 'unknown',
        // Absent for a still image; present and greater than 1 for an animation.
        pages: result.pages ?? 1,
      };
    },

    async encodedBytes({ path, format, animated }): Promise<number> {
      const buffer = await encoder(path, format, animated).toBuffer();
      return buffer.length;
    },

    async encodeToFile({ path, format, animated, destination }): Promise<number> {
      const { size } = await encoder(path, format, animated).toFile(destination);
      return size;
    },
  };
}
