import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ENCODE_QUALITY,
  type EncodeFormat,
  type ImageProbe,
  type ProbeDiagnostic,
  probeAssets,
} from './probe.js';
import type { Asset } from './types.js';

/**
 * `probeAssets` is pure over an injected port, so these run against a fake. The
 * sharp-backed implementation is tested on real bytes in `probe-sharp.test.ts`.
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
    quality: DEFAULT_ENCODE_QUALITY,
    encodeToFile: async () => 0,
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

    expect(result?.encoded).toEqual([
      { format: 'webp', bytes: 300, quality: DEFAULT_ENCODE_QUALITY.webp },
    ]);
  });

  it('measures nothing when asked for nothing, and still reads the header', async () => {
    // An empty `formats` skips only the encodes. Dimensions cost a millisecond or two,
    // so there is no reason to give them up.
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
      // Without `animated`, sharp encodes only the first frame, and a ten-frame GIF would
      // report a saving that is only achievable by destroying the animation.
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
      // A zero-byte file, a truncated PNG, a text file named `.png`: the run degrades
      // rather than crashing.
      const [result] = await probeAssets([asset('zero.png')], {
        probe: fakeProbe({ metadataFails: 'Input file contains unsupported image format' }),
        formats: ['webp'],
      });

      expect(result?.metadata).toBeNull();
      expect(result?.skipped).toEqual([
        {
          measurement: 'metadata',
          code: 'not-an-image',
          reason: 'this file could not be read as an image, so nothing about it could be measured',
        },
        {
          measurement: 'webp',
          code: 'not-an-image',
          reason: 'this file could not be read as an image, so there is nothing to encode',
        },
      ]);
    });

    it('keeps the library own words out of the skip and sends them to the sink', async () => {
      // The report is byte-identical for the same input, and libvips does not word the
      // same failure the same way every time. What Upfly concluded is stable and what
      // libvips said is not, so only the first reaches the report.
      const diagnostics: ProbeDiagnostic[] = [];
      const [result] = await probeAssets([asset('zero.png')], {
        probe: fakeProbe({ metadataFails: 'Input file contains unsupported image format' }),
        formats: [],
        onDiagnostic: (entry) => diagnostics.push(entry),
      });

      expect(result?.skipped[0]?.reason).not.toContain('Input file');
      expect(diagnostics).toEqual([
        {
          asset: 'zero.png',
          measurement: 'metadata',
          code: 'not-an-image',
          detail: 'Input file contains unsupported image format',
        },
      ]);
    });

    it('drops the library text entirely when nobody asked for it', async () => {
      // An absent sink means the unstable string is not quietly kept somewhere a
      // future renderer could find it.
      const [result] = await probeAssets([asset('zero.png')], {
        probe: fakeProbe({ metadataFails: 'Input file contains unsupported image format' }),
        formats: [],
      });

      expect(JSON.stringify(result)).not.toContain('Input file');
    });

    describe('failures classified by what the reader can do, not by what libvips said', () => {
      it('calls an unreadable SVG an SVG, and an unreadable PNG not an image', async () => {
        // A header failure is either a file that is not an image or an SVG the vector
        // parser refused, and libvips tells them apart only in wording the report does
        // not print. The extension separates them, and it is our own data. Both are fed
        // the same message: if the error text decided this, both would land together.
        const failing = { metadataFails: 'Input file has corrupt header: svgload: bad dimensions' };

        const [vector] = await probeAssets([asset('icon.svg')], {
          probe: fakeProbe(failing),
          formats: [],
        });
        const [raster] = await probeAssets([asset('photo.png')], {
          probe: fakeProbe(failing),
          formats: [],
        });

        expect(vector?.skipped[0]?.code).toBe('svg-unreadable');
        expect(raster?.skipped[0]?.code).toBe('not-an-image');
      });

      it('says what to do about each, in the reason a reader actually meets', async () => {
        const [vector] = await probeAssets([asset('icon.svg')], {
          probe: fakeProbe({ metadataFails: 'whatever libvips felt like saying' }),
          formats: [],
        });

        expect(vector?.skipped[0]?.reason).toContain('SVG');
        expect(vector?.skipped[0]?.reason).not.toContain('libvips');
        expect(vector?.skipped[0]?.reason).not.toContain('whatever');
      });

      it('formats the limit without asking the platform how to write a number', async () => {
        // The report is byte-identical for the same input on every machine.
        // `toLocaleString` goes through ICU even with an explicit locale, and a Node
        // built with `small-icu` can format the same number differently.
        const [result] = await probeAssets([asset('huge.png')], {
          probe: fakeProbe({ width: 40_000, height: 40_000, encodeFails: 'boom' }),
          formats: ['webp'],
        });

        expect(result?.skipped[0]?.reason).toContain('268,402,689');
      });

      it('names the pixel limit when the source is past it', async () => {
        // A source past the pixel limit has a clear fix, resizing it, so it gets its own
        // code. That is decided by arithmetic against `MAX_ENCODE_PIXELS`, a limit we set,
        // not by matching libvips' text: the message below has nothing to do with pixels,
        // so a string-matching implementation fails here.
        const [result] = await probeAssets([asset('huge.png')], {
          probe: fakeProbe({
            width: 40_000,
            height: 40_000,
            encodeFails: 'something else entirely',
          }),
          formats: ['webp'],
        });

        expect(result?.skipped[0]?.code).toBe('too-large-to-encode');
        expect(result?.skipped[0]?.reason).toContain('resize it');
      });

      it('counts every frame, because an animation is decoded as one strip', async () => {
        // A source read with `{ animated: true }` presents all its frames stacked, so
        // a ten-frame image offers ten times its own area to the decoder. Judging it
        // per frame would let an animation past the budget report the wrong cause.
        const perFrame = { width: 10_000, height: 2_000, encodeFails: 'boom' };

        const [still] = await probeAssets([asset('still.png')], {
          probe: fakeProbe({ ...perFrame, pages: 1 }),
          formats: ['webp'],
        });
        const [animated] = await probeAssets([asset('anim.gif')], {
          probe: fakeProbe({ ...perFrame, pages: 20 }),
          formats: ['webp'],
        });

        expect(still?.skipped[0]?.code).toBe('encode-failed');
        expect(animated?.skipped[0]?.code).toBe('too-large-to-encode');
      });

      it('keeps a plain encode failure unclassified rather than guessing', async () => {
        // An encode that failed for a reason we cannot attribute is reported as exactly
        // that. Folding it into another code to tidy the list would turn an unexplained
        // failure into an invented explanation.
        const [result] = await probeAssets([asset('hero.png')], {
          probe: fakeProbe({ width: 100, height: 50, encodeFails: 'out of memory' }),
          formats: ['webp'],
        });

        expect(result?.skipped[0]?.code).toBe('encode-failed');
      });

      it('does not claim a too-large source when the header never read', async () => {
        // The asset already has a header code. Adding `too-large-to-encode` on top
        // would be a second cause invented from dimensions we never measured.
        const [result] = await probeAssets([asset('broken.png')], {
          probe: fakeProbe({ metadataFails: 'nope' }),
          formats: ['webp'],
        });

        expect(result?.skipped.map((skip) => skip.code)).toEqual(['not-an-image', 'not-an-image']);
      });
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
          reason: 'the image decoded but re-encoding it failed, so there is no size to compare',
        },
      ]);
    });

    it('keeps a multi-line failure to its first line', async () => {
      const diagnostics: ProbeDiagnostic[] = [];
      await probeAssets([asset('a.png')], {
        probe: fakeProbe({
          metadataFails: 'Input file is missing: /repo/a.png\n  at Sharp.metadata',
        }),
        formats: [],
        onDiagnostic: (entry) => diagnostics.push(entry),
      });

      expect(diagnostics[0]?.detail).toBe('Input file is missing: /repo/a.png');
    });

    it('survives a port that throws something that is not an Error', async () => {
      const probe: ImageProbe = {
        quality: DEFAULT_ENCODE_QUALITY,
        encodeToFile: async () => 0,
        metadata: async () => {
          throw 'nope';
        },
        encodedBytes: async () => 0,
      };

      const diagnostics: ProbeDiagnostic[] = [];
      await probeAssets([asset('a.png')], {
        probe,
        formats: [],
        onDiagnostic: (entry) => diagnostics.push(entry),
      });

      expect(diagnostics[0]?.detail).toBe('nope');
    });

    it('lets one unreadable asset not stop the others', async () => {
      const probe: ImageProbe = {
        quality: DEFAULT_ENCODE_QUALITY,
        encodeToFile: async () => 0,
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

  describe('alwaysMeasure, so every asset a pattern could match is measured', () => {
    it('measures an exempt asset the cap would otherwise have excluded', async () => {
      const small = asset('small.png', 100);

      const results = await probeAssets([small, asset('huge.png', 9000), asset('mid.png', 500)], {
        probe: fakeProbe(),
        formats: ['webp'],
        maxEncodedAssets: 1,
        alwaysMeasure: [small],
      });

      const measured = results.filter((result) => result.encoded.length > 0);
      expect(measured.map((result) => result.relative).sort()).toEqual(['huge.png', 'small.png']);
    });

    it('does not spend a capped slot on the exempt asset', async () => {
      // The exempt asset is left out of the ranking, so it takes no slot. Counted
      // against the cap, it would take the slot of the largest asset and quietly turn
      // "the 1 largest" into "the 0 largest".
      const small = asset('small.png', 100);

      const results = await probeAssets([small, asset('huge.png', 9000), asset('mid.png', 500)], {
        probe: fakeProbe(),
        formats: ['webp'],
        maxEncodedAssets: 1,
        alwaysMeasure: [small],
      });

      const huge = results.find((result) => result.relative === 'huge.png');
      expect(huge?.encoded).toHaveLength(1);
      expect(huge?.skipped).toEqual([]);
    });

    it('still caps everything that was not exempted', async () => {
      const small = asset('small.png', 100);

      const results = await probeAssets([small, asset('huge.png', 9000), asset('mid.png', 500)], {
        probe: fakeProbe(),
        formats: ['webp'],
        maxEncodedAssets: 1,
        alwaysMeasure: [small],
      });

      const mid = results.find((result) => result.relative === 'mid.png');
      expect(mid?.encoded).toEqual([]);
      expect(mid?.skipped[0]).toMatchObject({ code: 'beyond-encode-cap' });
    });

    it('changes nothing when no cap is in force', async () => {
      const small = asset('small.png', 100);

      const results = await probeAssets([small, asset('huge.png', 9000)], {
        probe: fakeProbe(),
        formats: ['webp'],
        alwaysMeasure: [small],
      });

      expect(results.every((result) => result.encoded.length === 1)).toBe(true);
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

      // Every skipped measurement reaches the report with a reason, so the one left out
      // does not look as if it had no opportunity. The reason names the flag that lifts
      // the cap.
      const capped = results.find((result) => result.relative === 'small.png');
      expect(capped?.skipped).toEqual([
        {
          measurement: 'webp',
          code: 'beyond-encode-cap',
          // Names `--probe-all`, the flag a user wants at this moment, rather than
          // `--max-encodes`, which only raises the cap.
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
      // The same repository must give the same report on any machine, so which assets
      // are measured has to be deterministic too, not only the order they come back in.
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
        quality: DEFAULT_ENCODE_QUALITY,
        encodeToFile: async () => 0,
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
        quality: DEFAULT_ENCODE_QUALITY,
        encodeToFile: async () => 0,
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
