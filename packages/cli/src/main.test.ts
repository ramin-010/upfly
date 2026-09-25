import { describe, expect, it, vi } from 'vitest';

vi.mock('./audit.js', () => ({
  runAudit: async () => {
    throw new Error('the disk went away');
  },
}));

const { main } = await import('./main.js');

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: { write: (text: string) => out.push(text) },
      stderr: { write: (text: string) => err.push(text) },
      env: {},
    },
  };
}

describe('main, when a command throws', () => {
  it('reports it as unexpected and exits 4, a code no finding or refusal uses', async () => {
    const { io, out, err } = capture();
    expect(await main(['audit', '.'], io)).toBe(4);
    expect(out).toEqual([]);
    expect(err).toEqual(['upfly: failed unexpectedly: the disk went away\n']);
  });

  it('keeps stdout to JSON lines under --json', async () => {
    const { io, out } = capture();
    expect(await main(['audit', '.', '--json'], io)).toBe(4);
    expect(out.map((line) => JSON.parse(line))).toEqual([
      { type: 'error', command: 'audit', exitCode: 4, message: 'the disk went away' },
    ]);
  });
});
