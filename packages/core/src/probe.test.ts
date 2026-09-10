import { describe, expect, it, vi } from 'vitest';
import { type EncodeFormat, type ImageProbe, probeAssets } from './probe.js';
import type { Asset } from './types.js';

/**
 * `probeAssets` is pure over an injected port, so these run against a fake. The
 * sharp-backed implementation is exercised on real bytes in `probe-sharp.test.ts` —
 * the split is the point of the port.
 */

function asset(relative: string, bytes = 1000): Asset {
  return {
    path: `/repo/${relative}`,
    relative,
    extension: relative.slice(relative.lastIndexOf('.')),
    bytes,
  };
}

interface FakeOptions {
  readonly width?: number;
  readonly height?: number;
  readonly format?: string;
  readonly pages?: number;
  readonly sizes?: Partial<Record<EncodeFormat, number>>;
  readonly metadataFails?: string;
  readonly encodeFails?: string;
}

function fakeProbe(options: FakeOptions = {}): ImageProbe {
  return {
    metadata: async () => {
      if (options.metadataFails !== undefined) throw new Error(options.metadataFails);
      return {
        width: options.width ?? 100,
        height: options.height ?? 50,
        format: options.format ?? 'png',
        pages: options.pages ?? 1,
      };
    },
    encodedBytes: async ({ format }) => {
      if (options.encodeFails !== undefined) throw new Error(options.encodeFails);
      return options.sizes?.[format] ?? 400;
    },
  };
}

describe('probeAssets', () => {
  it('reads dimensions for every asset', async () => {
    const results = await probeAssets([asset('a.png'), asset('b.png')], {
      probe: fakeProbe({ width: 800, height: 600 }),
      formats: [],
    });

    expect(results.map((result) => [result.relative, result.metadata])).toEqual([
      ['a.png', { width: 800, height: 600, format: 'png', pages: 1 }],
      ['b.png', { width: 800, height: 600, format: 'png', pages: 1 }],
    ]);
  });

  it('measures only the formats it was asked for', async () => {
    const [result] = await probeAssets([asset('hero.png')], {
      probe: fakeProbe({ sizes: { webp: 300, avif: 120 } }),
      formats: ['webp'],
    });

    expect(result?.encoded).toEqual([{ format: 'webp', bytes: 300 }]);
  });

  it('measures nothing when asked for nothing, and still reads the header', async () => {
    // `--no-probe` for the expensive half. Dimensions cost 1-2 ms, so there is no
    // reason to give them up.
    const [result] = await probeAssets([asset('hero.png')], {
      probe: fakeProbe(),
      formats: [],
    });

    expect(result?.encoded).toEqual([]);
    expect(result?.metadata).not.toBeNull();
    expect(result?.skipped).toEqual([]);
  });

  it('orders encodes by format so two runs agree', async () => {
    const [result] = await probeAssets([asset('hero.png')], {
      probe: fakeProbe({ sizes: { webp: 300, avif: 120 } }),
      formats: ['webp', 'avif'],
    });

    expect(result?.encoded.map((entry) => entry.format)).toEqual(['avif', 'webp']);
  });

  describe('animation', () => {
    it('encodes an animated source as animated', async () => {
      // The finding that justifies this whole parameter: sharp keeps ONE frame
      // without it, so a ten-frame GIF would report a ~92% saving achievable only
      // by destroying the animation.
      const encodedBytes = vi.fn(async () => 8370);
      const probe: ImageProbe = { ...fakeProbe({ pages: 10, format: 'gif' }), encodedBytes };

      await probeAssets([asset('loop.gif')], { probe, formats: ['webp'] });

      expect(encodedBytes).toHaveBeenCalledWith(
        expect.objectContaining({ animated: true, format: 'webp' }),
      );
    });

    it('encodes a still source as still', async () => {
      const encodedBytes = vi.fn(async () => 300);
      const probe: ImageProbe = { ...fakeProbe({ pages: 1 }), encodedBytes };

      await probeAssets([asset('hero.png')], { probe, formats: ['webp'] });

      expect(encodedBytes).toHaveBeenCalledWith(expect.objectContaining({ animated: false }));
    });

    it('treats an unreadable header as still rather than guessing', async () => {
      // Unreachable through `probeAssets` (a failed header skips the encode), but
      // the default matters if that ordering ever changes: `animated: true` on a
      // still is the more expensive wrong answer.
      const [result] = await probeAssets([asset('broken.png')], {
        probe: fakeProbe({ metadataFails: 'Input file has corrupt header' }),
        formats: ['webp'],
      });

      expect(result?.encoded).toEqual([]);
    });
  });

  describe('what it declines to measure', () => {
    it('declines to encode an SVG, with a reason', async () => {
      // Encoding a vector measures a rasterisation at some arbitrary density, which
      // is not the question "how much would this shrink".
      const [result] = await probeAssets([asset('icon.svg')], {
        probe: fakeProbe({ format: 'svg' }),
        formats: ['webp'],
      });

      expect(result?.encoded).toEqual([]);
      expect(result?.skipped).toEqual([
        {
          measurement: 'webp',
          code: 'vector',
          reason: 'SVG is a vector: encoding it measures a rasterisation, not a saving',
        },
      ]);
      // Dimensions still work, and the `oversized` rule still applies to an SVG.
      expect(result?.metadata?.format).toBe('svg');
    });

    it('declines to encode an asset to the format it already is', async () => {
      const [result] = await probeAssets([asset('hero.webp')], {
        probe: fakeProbe({ format: 'webp' }),
        formats: ['webp', 'avif'],
      });

      expect(result?.encoded.map((entry) => entry.format)).toEqual(['avif']);
      expect(result?.skipped).toEqual([
        { measurement: 'webp', code: 'already-target-format', reason: 'already webp' },
      ]);
    });

    it('records a reason rather than throwing when the header is unreadable', async () => {
      // §5.1(e): a zero-byte file, a truncated PNG, a text file named `.png`. The
      // run degrades; it does not crash.
      const [result] = await probeAssets([asset('zero.png')], {
        probe: fakeProbe({ metadataFails: 'Input file contains unsupported image format' }),
        formats: ['webp'],
      });

      expect(result?.metadata).toBeNull();
      expect(result?.skipped).toEqual([
        {
          measurement: 'metadata',
          code: 'header-unreadable',
          reason: 'Input file contains unsupported image format',
        },
        {
          measurement: 'webp',
          code: 'header-unreadable',
          reason: 'the header could not be read, so there is nothing to encode',
        },
      ]);
    });

    it('records a reason when an encode fails after a good header', async () => {
      const [result] = await probeAssets([asset('hero.png')], {
        probe: fakeProbe({ encodeFails: 'VipsJpeg: premature end of JPEG image' }),
        formats: ['webp'],
      });

      expect(result?.metadata).not.toBeNull();
      expect(result?.encoded).toEqual([]);
      expect(result?.skipped).toEqual([
        {
          measurement: 'webp',
          code: 'encode-failed',
          reason: 'VipsJpeg: premature end of JPEG image',
        },
      ]);
    });

    it('keeps a multi-line failure to its first line', async () => {
      const [result] = await probeAssets([asset('a.png')], {
        probe: fakeProbe({
          metadataFails: 'Input file is missing: /repo/a.png\n  at Sharp.metadata',
        }),
        formats: [],
      });

      expect(result?.skipped[0]?.reason).toBe('Input file is missing: /repo/a.png');
    });

    it('survives a port that throws something that is not an Error', async () => {
      const probe: ImageProbe = {
        metadata: async () => {
          throw 'nope';
        },
        encodedBytes: async () => 0,
      };

      const [result] = await probeAssets([asset('a.png')], { probe, formats: [] });

      expect(result?.skipped[0]?.reason).toBe('nope');
    });

    it('lets one unreadable asset not stop the others', async () => {
      const probe: ImageProbe = {
        metadata: async (path) => {
          if (path.endsWith('bad.png')) throw new Error('unsupported image format');
          return { width: 10, height: 10, format: 'png', pages: 1 };
        },
        encodedBytes: async () => 100,
      };

      const results = await probeAssets([asset('bad.png'), asset('good.png')], {
        probe,
        formats: ['webp'],
      });

      expect(results[0]?.metadata).toBeNull();
      expect(results[1]?.metadata?.width).toBe(10);
    });
  });

  describe('the encode cap', () => {
    it('measures the largest sources and reports the rest as unmeasured', async () => {
      const results = await probeAssets(
        [asset('small.png', 100), asset('huge.png', 9000), asset('medium.png', 500)],
        { probe: fakeProbe(), formats: ['webp'], maxEncodedAssets: 2 },
      );

      const measured = results.filter((result) => result.encoded.length > 0);
      expect(measured.map((result) => result.relative)).toEqual(['huge.png', 'medium.png']);

      // Rule 9: the one left out says so, rather than looking like it had no
      // opportunity. And it names the flag that lifts the cap.
      const capped = results.find((result) => result.relative === 'small.png');
      expect(capped?.skipped).toEqual([
        {
          measurement: 'webp',
          code: 'beyond-encode-cap',
          // Points at `--probe-all`, the flag a user reaches for at exactly this
          // moment — not at the tunable that also happens to lift the cap.
          reason:
            'not among the 2 largest assets measured (run with --probe-all to measure the rest)',
        },
      ]);
    });

    it('still reads every header, so oversized findings stay complete', async () => {
      // What makes the cap safe: it degrades one finding of four. `dead` and
      // `broken` need no probe, and `oversized` needs only the ~1 ms header read.
      const results = await probeAssets([asset('a.png', 100), asset('b.png', 9000)], {
        probe: fakeProbe({ width: 4000, height: 3000 }),
        formats: ['webp'],
        maxEncodedAssets: 1,
      });

      expect(results.every((result) => result.metadata?.width === 4000)).toBe(true);
    });

    it('breaks a size tie by path, so two runs choose the same assets', async () => {
      // Rule 11 reaches the *selection*, not only the output order: the same
      // repository must produce the same report on any machine.
      const assets = [asset('z.png', 500), asset('a.png', 500), asset('m.png', 500)];

      const forwards = await probeAssets(assets, {
        probe: fakeProbe(),
        formats: ['webp'],
        maxEncodedAssets: 2,
      });
      const backwards = await probeAssets([...assets].reverse(), {
        probe: fakeProbe(),
        formats: ['webp'],
        maxEncodedAssets: 2,
      });

      const measured = (results: typeof forwards) =>
        results
          .filter((result) => result.encoded.length > 0)
          .map((result) => result.relative)
          .sort();

      expect(measured(forwards)).toEqual(['a.png', 'm.png']);
      expect(measured(backwards)).toEqual(['a.png', 'm.png']);
    });

    it('does not let an asset that could never be encoded occupy a slot', async () => {
      // An SVG is never encoded, so counting it would quietly turn "the two
      // largest" into "one asset and a vector".
      const results = await probeAssets(
        [asset('huge.svg', 9000), asset('big.png', 800), asset('small.png', 100)],
        { probe: fakeProbe(), formats: ['webp'], maxEncodedAssets: 2 },
      );

      expect(
        results.filter((result) => result.encoded.length > 0).map((result) => result.relative),
      ).toEqual(['big.png', 'small.png']);
    });

    it('measures everything when the cap is not reached', async () => {
      const results = await probeAssets([asset('a.png', 100), asset('b.png', 200)], {
        probe: fakeProbe(),
        formats: ['webp'],
        maxEncodedAssets: 10,
      });

      expect(results.every((result) => result.encoded.length === 1)).toBe(true);
      expect(results.every((result) => result.skipped.length === 0)).toBe(true);
    });

    it('measures everything when there is no cap', async () => {
      const results = await probeAssets([asset('a.png', 100), asset('b.png', 200)], {
        probe: fakeProbe(),
        formats: ['webp'],
      });

      expect(results.every((result) => result.encoded.length === 1)).toBe(true);
    });

    it('measures nothing at a cap of zero, and says so for each', async () => {
      const results = await probeAssets([asset('a.png', 100), asset('b.png', 200)], {
        probe: fakeProbe(),
        formats: ['webp'],
        maxEncodedAssets: 0,
      });

      expect(results.every((result) => result.encoded.length === 0)).toBe(true);
      expect(results.every((result) => result.skipped[0]?.code === 'beyond-encode-cap')).toBe(true);
    });
  });

  describe('batching', () => {
    it('keeps input order however the batches fall', async () => {
      const assets = Array.from({ length: 25 }, (_, index) =>
        asset(`img${String(index).padStart(2, '0')}.png`),
      );
      const probe: ImageProbe = {
        metadata: async (path) => {
          // Later assets resolve sooner, so an order-dependent bug would surface.
          await new Promise((done) => setTimeout(done, path.includes('img00') ? 15 : 0));
          return { width: 1, height: 1, format: 'png', pages: 1 };
        },
        encodedBytes: async () => 1,
      };

      const results = await probeAssets(assets, { probe, formats: [], concurrency: 7 });

      expect(results.map((result) => result.relative)).toEqual(
        assets.map((entry) => entry.relative),
      );
    });

    it('bounds how many run at once', async () => {
      let active = 0;
      let peak = 0;
      const probe: ImageProbe = {
        metadata: async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((done) => setTimeout(done, 5));
          active -= 1;
          return { width: 1, height: 1, format: 'png', pages: 1 };
        },
        encodedBytes: async () => 1,
      };

      await probeAssets(
        Array.from({ length: 12 }, (_, index) => asset(`a${index}.png`)),
        { probe, formats: [], concurrency: 3 },
      );

      expect(peak).toBeLessThanOrEqual(3);
    });

    it('probes nothing without complaint', async () => {
      expect(await probeAssets([], { probe: fakeProbe(), formats: ['webp'] })).toEqual([]);
    });
  });
});
