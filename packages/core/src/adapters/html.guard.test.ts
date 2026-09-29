/**
 * The last guard on a style attribute read through its character references, against a
 * decoder whose offset map is wrong. The map here has one entry per code point, so an emoji a
 * reference spells gets one entry for its two code units and every entry after it sits one
 * place early. The guard must refuse the attribute rather
 * than read a path at a range that no longer holds it.
 */

import { describe, expect, it, vi } from 'vitest';
import { htmlAdapter } from './html.js';

vi.mock('./reference-path.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./reference-path.js')>();
  return {
    ...real,
    decodeCharacterReferencesWithMap: (raw: string) => {
      const decoded = real.decodeCharacterReferencesWithMap(raw);
      if (decoded === null) return null;
      // Drop the second entry of each two-unit character a reference produced: both of its
      // entries hold the reference's start.
      const map = decoded.map.filter((offset, i) => {
        const unit = decoded.text.charCodeAt(i);
        const lowHalf = unit >= 0xdc00 && unit <= 0xdfff;
        return !(lowHalf && i > 0 && decoded.map[i - 1] === offset);
      });
      return { text: decoded.text, map };
    },
  };
});

describe('a style attribute whose offset map is wrong', () => {
  it('is refused, and no path is read at the wrong range', () => {
    const source =
      '<div style="--icon: &quot;&#x1F600;&quot;; background: url(&quot;/img/a.png&quot;)"></div>';

    const references = htmlAdapter.findReferences({ file: '/project/index.html', text: source });

    expect(references.map((reference) => [reference.rawPath, reference.ceiling])).toEqual([
      [expect.stringContaining('url('), 'unsafe'],
    ]);
  });
});
