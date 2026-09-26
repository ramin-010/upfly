import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
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
 * `probe.test.ts` covers the logic with a fake; this covers what a fake cannot: what
 * libvips does with an animation, a truncated file and a vector.
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
 * Built with `join: { animated: true }`. Neither `pageHeight` on raw input nor a tall
 * strip through `.gif()` produces multiple pages: both make a tall still image, which
 * gives a fixture that silently tests nothing.
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

    expect(result).toEqual({ width: 240, height: 160, format: 'jpeg', pages: 1 });
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
    // `encodedBytes` promises to write nothing, so that is asserted rather than
    // assumed: an encode that reached the disk would leave a file behind.
    expect(await readdir(temp)).toEqual(before);
  });

  it('measures an AVIF encode too', async () => {
    // Tiny, because an AVIF encode costs about eight times a WebP one. This only checks
    // that the format reaches libvips; the numbers live in `bench/`.
    const path = await noisyJpeg('avif.jpg', 24, 16);

    const bytes = await probe.encodedBytes({ path, format: 'avif', animated: false });

    expect(bytes).toBeGreaterThan(0);
  });

  describe('what it writes is what it measured', () => {
    it('writes exactly as many bytes as it reported', async () => {
      const path = await noisyJpeg('measured.jpg', 120, 90);
      const destination = join(temp, 'measured.webp');

      const measured = await probe.encodedBytes({ path, format: 'webp', animated: false });
      const written = await probe.encodeToFile({
        path,
        format: 'webp',
        animated: false,
        destination,
      });

      expect(written).toBe(measured);
      expect((await stat(destination)).size).toBe(measured);
    });

    it('writes at the quality it reports, byte for byte', async () => {
      // A saving quoted at a quality the file was not written at would be a false
      // figure. Compared with an independent encode at the declared quality, because
      // comparing the probe's output with itself would prove nothing.
      const { default: sharp } = await import('sharp');
      const path = await noisyJpeg('quality.jpg', 120, 90);
      const destination = join(temp, 'quality.webp');

      await probe.encodeToFile({ path, format: 'webp', animated: false, destination });
      const atDeclared = await sharp(path).webp({ quality: probe.quality.webp }).toBuffer();

      expect(Buffer.compare(await readFile(destination), atDeclared)).toBe(0);
    });

    it('would notice if the two used different qualities', async () => {
      // The control. If an encode at a different quality produced the same bytes, the
      // test above would pass whatever the probe did.
      const { default: sharp } = await import('sharp');
      const path = await noisyJpeg('control.jpg', 120, 90);

      const declared = await sharp(path).webp({ quality: probe.quality.webp }).toBuffer();
      const other = await sharp(path)
        .webp({ quality: probe.quality.webp - 30 })
        .toBuffer();

      expect(Buffer.compare(declared, other)).not.toBe(0);
    });
  });

  describe('hostile inputs', () => {
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

      // `failOn: 'none'` does not rescue this: it governs decode warnings, not header
      // parsing. There is no lenient mode, so the caller has to catch and report.
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

  describe('animation: the measurement that would otherwise be a lie', () => {
    it('reports frame count from a plain read', async () => {
      const path = await animatedGif('loop', 6);

      const result = await probe.metadata(path);

      // The plain read sees the frames, so detecting an animation costs nothing.
      expect(result.pages).toBe(6);
    });

    it('reports the dimensions of one frame, not of every frame stacked', async () => {
      const path = await animatedGif('loop2', 6);

      const result = await probe.metadata(path);

      // Read with `{ animated: true }`, this file reports a height six times larger,
      // every frame in one strip, and an oversized-by-dimensions finding fed from that
      // number would be wrong by a factor of six.
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
