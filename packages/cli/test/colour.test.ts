/**
 * The summary's colours, run in this process so that stdout can be a terminal, which a
 * spawned binary's never is: the brand's coral for the headline and the labels, bold for the
 * totals, dim for the secondary lines, red for a failure alone, and no escape code at all
 * wherever colour is off. Each terminal reports its colour depth as Node's terminal streams do.
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

/** The title's mark: the coral in bold. */
const CORAL = '\u001b[1;38;2;232;54;95m';
/** A label's mark: the coral alone. */
const LABEL = '\u001b[38;2;232;54;95m';

/**
 * Runs a command on a copy of the plain HTML site, which holds one broken reference, with
 * stdout a terminal showing `bits` of colour unless `tty` is false.
 */
async function run(
  args: readonly string[],
  env: Record<string, string>,
  options: { tty?: boolean; bits?: number; exit?: number } = {},
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
      getColorDepth: () => options.bits ?? 24,
    },
    stderr: { write: () => true, isTTY: tty },
    env,
  };
  const [command = '', ...rest] = args;
  const code = await main([command, root, ...rest], io);
  expect(code).toBe(options.exit ?? 0);
  return out;
}

describe('the summary on a terminal', () => {
  it('marks the title in bold coral, the labels in coral, totals in bold and secondary lines dim, and says the same words', async () => {
    const coloured = await run(['audit', '--no-probe'], {});
    const plain = await run(['audit', '--no-probe'], {}, { tty: false });

    expect(coloured).toContain(`${CORAL}Upfly\u001b[22;39m audit`);
    expect(coloured).toContain(`  ${LABEL}Images\u001b[39m       \u001b[1m11 images\u001b[22m`);
    expect(coloured).toContain(
      '\u001b[2m                 1 possibly unused: its name appears in the project\u001b[22m',
    );
    expect(coloured).not.toContain('\u001b[31m');
    expect(coloured.replace(ESCAPE, '')).toBe(plain);
  });

  it('uses the nearest of 256 where the terminal shows those, and where it shows 16, a bold title and plain labels', async () => {
    const of256 = await run(['audit', '--no-probe'], {}, { bits: 8 });
    const of16 = await run(['audit', '--no-probe'], {}, { bits: 4 });

    expect(of256).toContain('\u001b[1;38;5;161mUpfly\u001b[22;39m audit');
    expect(of256).toContain(
      '  \u001b[38;5;161mImages\u001b[39m       \u001b[1m11 images\u001b[22m',
    );
    expect(of16).toContain('\u001b[1mUpfly\u001b[22m audit');
    expect(of16).toContain('  Images       \u001b[1m11 images\u001b[22m');
    for (const red of ['\u001b[31m', '\u001b[91m', '38;']) expect(of16).not.toContain(red);
  });

  it('keeps red for a failure alone, beside plain labels on 16 colours', async () => {
    const failed = await run(['check'], {}, { bits: 4, exit: 1 });

    expect(failed).toContain('\u001b[1mUpfly\u001b[22m check');
    expect(failed).toContain('\u001b[31mFailed:\u001b[39m 1 reference names an image');
    expect(failed).toContain('\nReferences to images that do not exist (1)\n');
    expect(failed.split('\u001b[31m')).toHaveLength(2);
  });

  it('prints no escape code under NO_COLOR, --no-color, a dumb terminal, or a stream that is not a terminal', async () => {
    const outputs = [
      await run(['audit', '--no-probe'], { NO_COLOR: '1' }),
      await run(['audit', '--no-probe', '--no-color'], {}),
      await run(['audit', '--no-probe'], { TERM: 'dumb' }),
      await run(['audit', '--no-probe'], { COLORTERM: 'truecolor' }, { tty: false }),
    ];
    for (const output of outputs) {
      expect(output).toContain('Upfly audit');
      expect(output.includes('\u001b')).toBe(false);
    }
  });
});
