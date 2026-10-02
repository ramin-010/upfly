/**
 * The README npm shows is the repository's, copied in by `prepack` with its relative paths
 * made absolute: npm's page has no repository to resolve them against.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { withAbsoluteLinks } from './prepack.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FOLDERS = new Set(['accuracy-suite', 'packages/core', 'packages/cli/schema']);
const isFolder = (relative: string) => FOLDERS.has(relative);

/** Every link or image target in Markdown or in an HTML attribute, outside fenced code. */
function targets(markdown: string): string[] {
  const outside = markdown.split(/^```[^\n]*\n[\s\S]*?^```$/m).join('\n');
  return [
    ...[...outside.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)].map((match) => match[1] ?? ''),
    ...[...outside.matchAll(/\b(?:src|srcset|href)="([^"]+)"/g)].map((match) => match[1] ?? ''),
  ];
}

describe('withAbsoluteLinks', () => {
  it('points a link at its page on GitHub, under tree for a folder and blob for a file', () => {
    expect(withAbsoluteLinks('[the design](ARCHITECTURE.md#the-transaction)', isFolder)).toBe(
      '[the design](https://github.com/upflyjs/upfly/blob/v3/ARCHITECTURE.md#the-transaction)',
    );
    expect(withAbsoluteLinks('[the suite](accuracy-suite/)', isFolder)).toBe(
      '[the suite](https://github.com/upflyjs/upfly/tree/v3/accuracy-suite)',
    );
    expect(withAbsoluteLinks('<a href="./packages/core">core</a>', isFolder)).toBe(
      '<a href="https://github.com/upflyjs/upfly/tree/v3/packages/core">core</a>',
    );
  });

  it('points an image at its raw file, in Markdown and in HTML, so a page can show it', () => {
    expect(withAbsoluteLinks('![logo](assets/logo.svg)', isFolder)).toBe(
      '![logo](https://raw.githubusercontent.com/upflyjs/upfly/v3/assets/logo.svg)',
    );
    expect(
      withAbsoluteLinks(
        '<source srcset="assets/dark.svg">\n<img src="assets/light.svg" alt="upfly">',
        isFolder,
      ),
    ).toBe(
      [
        '<source srcset="https://raw.githubusercontent.com/upflyjs/upfly/v3/assets/dark.svg">',
        '<img src="https://raw.githubusercontent.com/upflyjs/upfly/v3/assets/light.svg" alt="upfly">',
      ].join('\n'),
    );
  });

  it('leaves an address, a fragment, a path from the root and fenced code as they are', () => {
    const kept = [
      '[npm](https://www.npmjs.com/package/upfly) [mail](mailto:a@example.com)',
      '[below](#limits) [root](/docs/a.md)',
      '```',
      '[not a link](README.md) <img src="a.png">',
      '```',
    ].join('\n');

    expect(withAbsoluteLinks(kept, isFolder)).toBe(kept);
  });

  it('leaves no relative path in the repository README, and keeps every word of it', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');

    const published = withAbsoluteLinks(readme, isFolder);

    expect(targets(readme).some((target) => !/^(?:https?:|mailto:|#)/.test(target))).toBe(true);
    expect(targets(published).filter((target) => !/^(?:https?:|mailto:|#)/.test(target))).toEqual(
      [],
    );
    // Every target blanked, the two texts are the same: only addresses changed.
    const blanked = (text: string) =>
      text.replace(/\]\([^)\s]+\)/g, '](_)').replace(/\b(src|srcset|href)="[^"]+"/g, '$1="_"');
    expect(blanked(published)).toBe(blanked(readme));
  });
});
