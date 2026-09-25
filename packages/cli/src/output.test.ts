import { describe, expect, it } from 'vitest';
import { type Output, colourFor, paint, progressReporter } from './output.js';

const terminal: Output = { write: () => true, isTTY: true };
const pipe: Output = { write: () => true };
const plain = { json: false, noColor: false };

describe('colourFor', () => {
  it('colours a terminal and nothing else', () => {
    expect(colourFor(terminal, {}, plain)).toBe(true);
    expect(colourFor(pipe, {}, plain)).toBe(false);
  });

  it('turns colour off for --no-color, --json and a non-empty NO_COLOR', () => {
    expect(colourFor(terminal, {}, { json: false, noColor: true })).toBe(false);
    expect(colourFor(terminal, {}, { json: true, noColor: false })).toBe(false);
    expect(colourFor(terminal, { NO_COLOR: '1' }, plain)).toBe(false);
    expect(colourFor(terminal, { NO_COLOR: 'false' }, plain)).toBe(false);
  });

  it('keeps colour when NO_COLOR is set but empty, as the convention says', () => {
    expect(colourFor(terminal, { NO_COLOR: '' }, plain)).toBe(true);
  });

  it('paints only when asked', () => {
    expect(paint(false, 'red', 'x')).toBe('x');
    expect(paint(true, 'red', 'x')).toBe('\u001b[31mx\u001b[39m');
  });
});

describe('progressReporter', () => {
  function capture(isTTY: boolean) {
    const out: string[] = [];
    const err: string[] = [];
    const io = {
      stdout: { write: (text: string) => out.push(text), isTTY },
      stderr: { write: (text: string) => err.push(text), isTTY },
      env: {},
    };
    return { io, out, err };
  }

  it('writes a JSON line per stage under --json', () => {
    const { io, out, err } = capture(false);
    const progress = progressReporter(io, 'audit', true);
    progress.update({ stage: 'discovered', images: 3, files: 9 });
    expect(out).toEqual([
      '{"type":"progress","command":"audit","stage":"discovered","images":3,"files":9}\n',
    ]);
    expect(err).toEqual([]);
  });

  it('overwrites one line on a terminal and clears it after', () => {
    const { io, out, err } = capture(true);
    const progress = progressReporter(io, 'audit', false);
    progress.update({ stage: 'scanned', references: 12 });
    progress.clear();
    expect(out).toEqual([]);
    expect(err).toEqual(['\r\u001b[2Kscanned: 12 references', '\r\u001b[2K']);
  });

  it('says nothing when stderr is a file or a pipe', () => {
    const { io, out, err } = capture(false);
    const progress = progressReporter(io, 'audit', false);
    progress.update({ stage: 'scanned', references: 12 });
    progress.clear();
    expect([...out, ...err]).toEqual([]);
  });
});
