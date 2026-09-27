import { crc32, deflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const framed = Buffer.alloc(body.length + 8);
  framed.writeUInt32BE(data.length, 0);
  body.copy(framed, 4);
  framed.writeUInt32BE(crc32(body), body.length + 4);
  return framed;
}

/**
 * An animated PNG, built by hand because sharp reads the format but cannot write it.
 *
 * Each frame is raw RGB, `width` by `height`, shown for a tenth of a second. The first frame
 * is also the still image a decoder that does not animate shows. A `tEXt` chunk comes before
 * the animation's `acTL`, so a reader has to skip chunks to find it.
 * See https://wiki.mozilla.org/APNG_Specification.
 */
export function animatedPng(width: number, height: number, frames: readonly Buffer[]): Buffer {
  let sequence = 0;
  const control = (): Buffer => {
    const data = Buffer.alloc(26);
    data.writeUInt32BE(sequence++, 0);
    data.writeUInt32BE(width, 4);
    data.writeUInt32BE(height, 8);
    data.writeUInt16BE(1, 20);
    data.writeUInt16BE(10, 22);
    return chunk('fcTL', data);
  };
  const pixels = (frame: Buffer): Buffer => {
    const rows: Buffer[] = [];
    for (let y = 0; y < height; y++) {
      rows.push(Buffer.from([0]), frame.subarray(y * width * 3, (y + 1) * width * 3));
    }
    return deflateSync(Buffer.concat(rows));
  };

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const animation = Buffer.alloc(8);
  animation.writeUInt32BE(frames.length, 0);
  const comment = Buffer.concat([Buffer.from('Comment', 'latin1'), Buffer.from([0])]);

  const parts = [
    SIGNATURE,
    chunk('IHDR', header),
    chunk('tEXt', Buffer.concat([comment, Buffer.from('made by hand', 'latin1')])),
    chunk('acTL', animation),
  ];
  frames.forEach((frame, index) => {
    parts.push(control());
    if (index === 0) {
      parts.push(chunk('IDAT', pixels(frame)));
      return;
    }
    const order = Buffer.alloc(4);
    order.writeUInt32BE(sequence++, 0);
    parts.push(chunk('fdAT', Buffer.concat([order, pixels(frame)])));
  });
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/** Frames of a gradient that moves, which a still encode of the first frame shrinks a lot. */
export function gradientFrames(size: number, count: number): Buffer[] {
  return Array.from({ length: count }, (_, frame) => {
    const pixels = Buffer.alloc(size * size * 3);
    for (let pixel = 0; pixel < size * size; pixel++) {
      const x = pixel % size;
      const y = Math.floor(pixel / size);
      pixels.set(
        [(x * 2 + frame * 20) % 256, (y * 2) % 256, (x + y + frame * 10) % 256],
        pixel * 3,
      );
    }
    return pixels;
  });
}
