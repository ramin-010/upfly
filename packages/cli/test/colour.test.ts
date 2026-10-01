/**
 * The summary's colours, run in this process so that stdout can be a terminal, which a
 * spawned binary's never is: the brand's coral for the headline and the labels, bold for the
 * totals, dim for the secondary lines, and no escape code at all wherever colour is off.
 */

import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/main.js';
import { copyFixture, tempFolder } from './helpers.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** An escape code that sets a style, built from its character code as a regular expression. */
const ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

async function audit(
  env: Record<string, string>,
  options: { tty?: boolean; flags?: string[] } = {},
) {
  const root = copyFixture('plain-html', tempFolder(roots, 'upfly-colour-'));
  let out = '';
  const tty = options.tty ?? true;
  const io = {
    stdout: {
      write: (text: string) => {
        out += text;
        return true;
      },
      isTTY: tty,
    },
    stderr: { write: () => true, isTTY: tty },
    env,
  };
  const code = await main(['audit', root, '--no-probe', ...(options.flags ?? [])], io);
  expect(code).toBe(0);
  return out;
}

describe('the summary on a terminal', () => {
  it('marks the headline and labels in coral, totals in bold and secondary lines dim, and says the same words', async () => {
    const coloured = await audit({});
    const plain = await audit({}, { tty: false });

    expect(coloured).toContain('\u001b[1;91mUpfly\u001b[22;39m audit');
    expect(coloured).toContain(
      '  \u001b[1;91mImages\u001b[22;39m       \u001b[1m11 images\u001b[22m',
    );
    expect(coloured).toContain(
      '\u001b[2m                 1 possibly unused: its name appears in the project\u001b[22m',
    );
    expect(coloured).not.toContain('\u001b[31m');
    expect(coloured.replace(ESCAPE, '')).toBe(plain);
  });

  it('uses the exact coral when the terminal says it shows 24-bit colour, and the nearest of 256 when it shows those', async () => {
    expect(await audit({ COLORTERM: 'truecolor' })).toContain(
      '\u001b[1;38;2;232;54;95mUpfly\u001b[22;39m',
    );
    expect(await audit({ COLORTERM: '24bit' })).toContain('\u001b[1;38;2;232;54;95m');
    expect(await audit({ TERM: 'xterm-256color' })).toContain('\u001b[1;38;5;161mUpfly');
  });

  it('prints no escape code under NO_COLOR, --no-color, a dumb terminal, or a stream that is not a terminal', async () => {
    const outputs = [
      await audit({ NO_COLOR: '1' }),
      await audit({}, { flags: ['--no-color'] }),
      await audit({ TERM: 'dumb' }),
      await audit({ COLORTERM: 'truecolor' }, { tty: false }),
    ];
    for (const output of outputs) {
      expect(output).toContain('Upfly audit');
      expect(output.includes('\u001b')).toBe(false);
    }
  });
});
