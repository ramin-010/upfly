/**
 * The summary's colours, run in this process so that stdout can be a terminal, which a
 * spawned binary's never is: the brand's coral in bold for the headline and the labels, the
 * values at the terminal's own weight, dim for the secondary lines, red for a failure alone,
 * and no escape code at all wherever colour is off. Each terminal reports its colour depth as
 * Node's terminal streams do.
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

/** The mark of the headline's name and the labels: the coral in bold. */
const CORAL = '\u001b[1;38;2;232;54;95m';

/** A copy of the plain HTML site, which holds one broken reference. */
function plainHtml(): string {
  return copyFixture('plain-html', tempFolder(roots, 'upfly-colour-'));
}

/**
 * Runs a command on `root`, a fresh copy of the plain HTML site unless given, with stdout a
 * terminal showing `bits` of colour unless `tty` is false.
 */
async function run(
  args: readonly string[],
  env: Record<string, string>,
  options: { tty?: boolean; bits?: number; exit?: number; root?: string } = {},
) {
  const root = options.root ?? plainHtml();
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
  it('marks the headline and labels in bold coral, leaves the values plain, dims secondary lines, and says the same words', async () => {
    // One copy for both runs: the Next line names the folder, and two copies' names differ.
    const root = plainHtml();
    const coloured = await run(['audit', '--no-probe'], {}, { root });
    const plain = await run(['audit', '--no-probe'], {}, { tty: false, root });

    expect(coloured).toContain(`${CORAL}Upfly\u001b[22;39m audit`);
    expect(coloured).toContain(`  ${CORAL}Images\u001b[22;39m       11 images, 152.5 KB\n`);
    expect(coloured).toContain(
      '\u001b[2m                 1 possibly unused: its name appears in the project\u001b[22m',
    );
    expect(coloured).not.toContain('\u001b[31m');
    expect(coloured.replace(ESCAPE, '')).toBe(plain);
  });

  it('uses the nearest of 256 where the terminal shows those, and bold alone where it shows 16', async () => {
    const of256 = await run(['audit', '--no-probe'], {}, { bits: 8 });
    const of16 = await run(['audit', '--no-probe'], {}, { bits: 4 });

    expect(of256).toContain('\u001b[1;38;5;161mUpfly\u001b[22;39m audit');
    expect(of256).toContain('  \u001b[1;38;5;161mImages\u001b[22;39m       11 images');
    expect(of16).toContain('\u001b[1mUpfly\u001b[22m audit');
    expect(of16).toContain('  \u001b[1mImages\u001b[22m       11 images');
    for (const red of ['\u001b[31m', '\u001b[91m', '38;']) expect(of16).not.toContain(red);
  });

  it('keeps red for a failure alone, beside labels that are bold on 16 colours', async () => {
    const failed = await run(['check'], {}, { bits: 4, exit: 1 });

    expect(failed).toContain('\u001b[1mUpfly\u001b[22m check');
    expect(failed).toContain('\u001b[31mFailed:\u001b[39m 1 reference names an image');
    expect(failed).toContain('\u001b[1mReferences to images that do not exist (1)\u001b[22m');
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
