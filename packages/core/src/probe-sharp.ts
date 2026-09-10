/**
 * The real `ImageProbe`, backed by sharp. Read-only: it never writes a byte.
 *
 * One of the three modules allowed to touch a disk, alongside `discover` and (in
 * Phase 2) `execute`. Phase 2's *writing* encoder extends this rather than
 * duplicating it — the decisions below about animation and dimensions are exactly
 * the ones a writer has to get right too.
 *
 * **sharp is imported lazily, on purpose.** It is a native module, and v2's worst
 * bug was a native module shipped for one platform and broken everywhere else for
 * months. A top-level import would load the binary the moment anything in
 * `upfly-core` is imported, so `upfly audit --no-probe` would fail on a machine with
 * a mismatched binary even though it needs no pixels at all. Deferring the import to
 * the moment someone actually asks for a probe keeps that escape hatch real.
 */

import type { EncodeFormat, ImageMetadata, ImageProbe } from './probe.js';

/**
 * Build the sharp-backed probe.
 *
 * Async because of the lazy import. The rejection is worth catching: on a broken
 * native install this is where the user finds out, and it is a much better place
 * than halfway through an audit.
 */
export async function createSharpProbe(): Promise<ImageProbe> {
  const { default: sharp } = await import('sharp');

  return {
    async metadata(path: string): Promise<ImageMetadata> {
      // Deliberately a *plain* read, not `{ animated: true }`. For an animated GIF
      // the animated read reports every frame stacked into one strip — sharp's own
      // 370×285 ten-frame fixture comes back as 370×2850 — which would make an
      // "oversized by dimensions" finding wrong by a factor of ten. The plain read
      // gives one frame's dimensions and still reports `pages`, so it answers both
      // questions in one pass.
      const result = await sharp(path).metadata();

      return {
        width: result.width ?? 0,
        height: result.height ?? 0,
        format: result.format ?? 'unknown',
        // Absent for a still image; present and > 1 for an animation.
        pages: result.pages ?? 1,
      };
    },

    async encodedBytes({ path, format, animated }): Promise<number> {
      // `{ animated }` is not optional in spirit. Without it sharp keeps the first
      // frame and nothing else: that same ten-frame fixture encodes to 616 bytes
      // instead of 8 370, so the "saving" reported for every animated GIF in a
      // repository would be one only achievable by destroying the animation.
      const buffer = await encoder(sharp(path, { animated }), format).toBuffer();
      return buffer.length;
    },
  };
}

/** Apply the output format. Quality is left at sharp's defaults until Phase 2 owns it. */
function encoder<T extends { webp: () => T; avif: () => T }>(pipeline: T, format: EncodeFormat): T {
  switch (format) {
    case 'webp':
      return pipeline.webp();
    case 'avif':
      return pipeline.avif();
    default: {
      const unhandled: never = format;
      return unhandled;
    }
  }
}
