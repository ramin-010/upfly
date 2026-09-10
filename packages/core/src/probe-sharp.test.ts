import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSharpProbe } from './probe-sharp.js';
import { probeAssets } from './probe.js';
import type { ImageProbe } from './probe.js';
import type { Asset } from './types.js';

/**
 * The sharp-backed probe, against real bytes.
 *
 * `probe.test.ts` covers the logic with a fake; this covers the half a fake cannot:
 * what libvips actually does with an animation, a truncated file and a vector. Every
 * expectation here was measured with a throwaway script before it was written down.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures');

let probe: ImageProbe;
let temp: string;

beforeAll(async () => {
  probe = await createSharpProbe();
  temp = await mkdtemp(join(tmpdir(), 'upfly-probe-'));
});

afterAll(async () => {
  await rm(temp, { recursive: true, force: true }).catch(() => undefined);
});

function asset(path: string, relative: string): Asset {
  return { path, relative, extension: relative.slice(relative.lastIndexOf('.')), bytes: 0 };
}

/** A real JPEG with content the encoders cannot trivially collapse. */
async function noisyJpeg(name: string, width: number, height: number): Promise<string> {
  const { default: sharp } = await import('sharp');
  const pixels = Buffer.alloc(width * height * 3);
  for (let index = 0; index < pixels.length; index++) pixels[index] = (index * 2654435761) % 251;

  const path = join(temp, name);
  await sharp(pixels, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 90 })
    .toFile(path);
  return path;
}

const FRAME_WIDTH = 24;
const FRAME_HEIGHT = 12;

/**
 * A genuinely animated GIF.
 *
 * `join: { animated: true }` is the way to build one — neither `pageHeight` on raw
 * input nor a tall strip through `.gif()` produces multiple pages, they just make a
 * tall still image. Getting that wrong gives a fixture that silently tests nothing,
 * which is how the animation bug survives review in the first place.
 */
async function animatedGif(name: string, frames: number): Promise<string> {
  const { default: sharp } = await import('sharp');

  const pages = await Promise.all(
    Array.from({ length: frames }, (_, index) =>
      sharp({
        create: {
          width: FRAME_WIDTH,
          height: FRAME_HEIGHT,
          channels: 3,
          background: { r: index * 40, g: 100, b: 200 },
        },
      })
        .png()
        .toBuffer(),
    ),
  );

  const path = join(temp, `${name}.gif`);
  await sharp(pages, { join: { animated: true } })
    .gif()
    .toFile(path);
  return path;
}

describe('createSharpProbe', () => {
  it('reads a real fixture image', async () => {
    const result = await probe.metadata(join(FIXTURES, 'plain-html/images/hero.jpg'));

    expect(result).toEqual({ width: 1, height: 1, format: 'jpeg', pages: 1 });
  });

  it('reports a still image as one page', async () => {
    const path = await noisyJpeg('still.jpg', 40, 30);

    expect(await probe.metadata(path)).toEqual({
      width: 40,
      height: 30,
      format: 'jpeg',
      pages: 1,
    });
  });

  it('reads an SVG without rasterising it', async () => {
    const path = join(temp, 'icon.svg');
    await writeFile(path, '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16"/>');

    expect(await probe.metadata(path)).toEqual({
      width: 24,
      height: 16,
      format: 'svg',
      pages: 1,
    });
  });

  it('measures an encode without writing anything', async () => {
    const path = await noisyJpeg('encode.jpg', 60, 40);
    const before = await readdir(temp);

    const bytes = await probe.encodedBytes({ path, format: 'webp', animated: false });

    expect(bytes).toBeGreaterThan(0);
    // "Read-only" is the whole promise of this module, so it is asserted rather
    // than assumed: an encode that reached a disk would leave a file behind.
    expect(await readdir(temp)).toEqual(before);
  });

  it('measures an AVIF encode too', async () => {
    // Deliberately tiny. AVIF is ~8x the cost of WebP (R11), so the point here is
    // only that the format actually reaches libvips — the numbers live in `bench/`.
    const path = await noisyJpeg('avif.jpg', 24, 16);

    const bytes = await probe.encodedBytes({ path, format: 'avif', animated: false });

    expect(bytes).toBeGreaterThan(0);
  });

  describe('hostile inputs — §5.1(e)', () => {
    it('rejects a zero-byte file', async () => {
      const path = join(temp, 'zero.png');
      await writeFile(path, Buffer.alloc(0));

      await expect(probe.metadata(path)).rejects.toThrow(/unsupported image format/i);
    });

    it('rejects a text file wearing a .png extension', async () => {
      const path = join(temp, 'text.png');
      await writeFile(path, 'this is not a png, it merely has the extension');

      await expect(probe.metadata(path)).rejects.toThrow(/unsupported image format/i);
    });

    it('rejects a truncated image', async () => {
      const source = await noisyJpeg('whole.jpg', 40, 40);
      const { readFile } = await import('node:fs/promises');
      const path = join(temp, 'truncated.jpg');
      await writeFile(path, (await readFile(source)).subarray(0, 24));

      // Worth knowing: `failOn: 'none'` does NOT rescue this. It governs decode
      // warnings, not header parsing, so there is no lenient mode to reach for —
      // catching and reporting is the only option.
      await expect(probe.metadata(path)).rejects.toThrow(/corrupt header|unsupported/i);
    });

    it('rejects a file that is not there', async () => {
      await expect(probe.metadata(join(temp, 'absent.png'))).rejects.toThrow(/missing/i);
    });

    it('turns every one of those into a reported reason rather than a crash', async () => {
      const zero = join(temp, 'zero2.png');
      await writeFile(zero, Buffer.alloc(0));

      const results = await probeAssets(
        [asset(zero, 'zero2.png'), asset(join(temp, 'absent2.png'), 'absent2.png')],
        { probe, formats: ['webp'] },
      );

      expect(results.map((result) => result.metadata)).toEqual([null, null]);
      expect(results.every((result) => result.skipped.length === 2)).toBe(true);
    });
  });

  describe('animation — the measurement that would otherwise be a lie', () => {
    it('reports frame count from a plain read', async () => {
      const path = await animatedGif('loop', 6);

      const result = await probe.metadata(path);

      // The plain read sees the frames, so detecting an animation costs nothing.
      expect(result.pages).toBe(6);
    });

    it('reports the dimensions of ONE frame, not of every frame stacked', async () => {
      const path = await animatedGif('loop2', 6);

      const result = await probe.metadata(path);

      // Read with `{ animated: true }` this same file reports a height six times
      // larger — every frame in one strip. An `oversized by dimensions` finding fed
      // from that number would be wrong by a factor of six.
      expect(result.height).toBe(FRAME_HEIGHT);
      expect(result.width).toBe(FRAME_WIDTH);
    });

    it('measures an animated encode as animated, not as its first frame', async () => {
      const path = await animatedGif('loop3', 6);

      const asOneFrame = await probe.encodedBytes({ path, format: 'webp', animated: false });
      const asAnimation = await probe.encodedBytes({ path, format: 'webp', animated: true });

      // This is the whole reason `animated` is on the port. Measuring the first
      // frame reports a saving achievable only by throwing the other five away.
      expect(asAnimation).toBeGreaterThan(asOneFrame);
    });

    it('passes `animated` through from the metadata it already read', async () => {
      const path = await animatedGif('loop4', 6);

      const [result] = await probeAssets([asset(path, 'loop4.gif')], {
        probe,
        formats: ['webp'],
      });
      const asOneFrame = await probe.encodedBytes({ path, format: 'webp', animated: false });

      expect(result?.encoded[0]?.bytes).toBeGreaterThan(asOneFrame);
    });
  });
});
