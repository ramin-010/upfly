/**
 * The two shapes R88 moved into the disposition tier, and the rule that decides them.
 *
 * A shape is a DISPOSITION when what would take the reference out is a property of how
 * the path is WRITTEN — so it is keyed identically in every host and beats every host
 * and construct shape. `path.absolute-url` has always worked that way; these two were
 * named `html.charref` and `js.import.package`, which put them in the wrong namespace
 * and made an already-written rule unreadable.
 *
 * 🔴 **These are the tests that would have failed.** Before R88(b) the bare-specifier
 * disposition was reachable only from an `import`: the identical string in a `require()`
 * was `js.require` and in a plain `const` was `js.string.literal`, so one matrix row
 * covering one predicate was scattered across three. Nothing measured it, because a
 * shape audit that joins on position sees three references where three are expected.
 */

import { describe, expect, it } from 'vitest';
import type { RawReference } from '../types.js';
import { htmlAdapter } from './html.js';
import { javascriptAdapter } from './javascript.js';

function js(text: string, file = '/project/src/app.ts'): RawReference[] {
  return javascriptAdapter.findReferences({ file, text });
}

function html(text: string): RawReference[] {
  return htmlAdapter.findReferences({ file: '/project/index.html', text });
}

/** The one reference a source is expected to produce, so a miscount fails loudly. */
function only(references: readonly RawReference[]): RawReference {
  expect(references).toHaveLength(1);
  return references[0] as RawReference;
}

describe('path.bare-specifier — the disposition beats the construct (R88(b))', () => {
  it.each([
    ['a static import', "import logo from 'some-ui-kit/dist/logo.png';"],
    ['a dynamic import', "const m = await import('some-ui-kit/dist/logo.png');"],
    ['require()', "const logo = require('some-ui-kit/dist/logo.png');"],
  ])('claims %s as path.bare-specifier', (_name, source) => {
    expect(only(js(source)).shape).toBe('path.bare-specifier');
  });

  it('🔴 does NOT claim the identical text in a PLAIN STRING, and that is measured', () => {
    // R88(b) reads the tree's three entries as one row because "all three fail together
    // if bare-specifier detection breaks". Two do. In an ordinary string the prefix test
    // decides nothing: `some-ui-kit/dist/x.png` and `src/assets/x.png` are the same
    // syntax, and only node_modules separates them.
    //
    // ⚠️ Asserting it here labelled 351 corpus references as packages — `loading...`,
    // `bs.button`, `v2.0.0`, `berryhouse.ca` across railsgirls-com and eleventy-docs.
    // The key keeps the entry and `path.bare-specifier` declares `adapterEmitsAs` for it.
    const source = "export const PACKAGED = 'some-ui-kit/dist/logo.png';";

    expect(only(js(source)).shape).toBe('js.string.literal');
  });

  it('leaves a project-relative path on its own construct', () => {
    // The control. Without it every assertion above would pass with the predicate
    // stuck at `true`, and every import in the corpus would read as a package.
    expect(only(js("import logo from './logo.png';")).shape).toBe('js.import.static');
    expect(only(js("const logo = require('../logo.png');")).shape).toBe('js.require');
    expect(only(js("export const HERO = '/img/hero.png';")).shape).toBe('js.string.literal');
  });

  it('🔴 does NOT apply to new URL(…, import.meta.url), where a bare path is relative', () => {
    // The same spelling with the opposite meaning, decided entirely by the construct:
    // `new URL('img.png', import.meta.url)` resolves against the module, so calling it
    // a package would report a real, rewritable asset as out of scope.
    const source = "const u = new URL('img.png', import.meta.url);";

    expect(only(js(source)).shape).toBe('js.new-url');
  });

  it('leaves an alias-shaped specifier to the construct, because the table is elsewhere', () => {
    // `@scope/pkg/x.png` and an `@img/*` tsconfig alias are the same syntax. Deciding
    // between them needs the paths table, which this layer cannot see (R87) — so the
    // adapter must NOT claim it either way.
    for (const prefix of ['~', '@', '#']) {
      const source = `import art from '${prefix}img/aliased.png';`;
      expect(only(js(source)).shape, prefix).toBe('js.import.static');
    }
  });
});

describe('path.charref — the spelling beats the construct (R88(a))', () => {
  it('claims a character-referenced img@src as path.charref', () => {
    expect(only(html('<img src="/gallery/a&amp;b.png">')).shape).toBe('path.charref');
  });

  it('🔴 claims it in an feImage too, rather than as the construct it sits in', () => {
    // The case that could not be settled by "the narrowest thing that breaks alone":
    // both `html.svg.feimage` and the charref decoding break other entries with them.
    // The tier decides it — and the engine already had the order right, because the
    // charref branch fires before any host shape is chosen. Only the name disagreed.
    const source = '<svg><filter><feImage xlink:href="/gallery/a&amp;b.png" /></filter></svg>';

    expect(only(html(source)).shape).toBe('path.charref');
  });

  it('leaves the same feImage on its construct when the path has no entity', () => {
    // The control: without it the assertion above would pass with feImage support
    // deleted outright.
    const source = '<svg><filter><feImage xlink:href="/img/texture.png" /></filter></svg>';

    expect(only(html(source)).shape).toBe('html.svg.feimage');
  });

  /**
   * ⚠️ **This assertion read `unsafe` until R118, and its stated reason was the thing
   * that was wrong.** *20 source characters, 16 decoded, so a rewrite over the source
   * range would truncate the document* is an argument against writing the DECODED path
   * back — which nothing does. `rawPath` is the encoded source text, the range covers
   * exactly that text, and `relocate` re-encodes what it writes. **The invariant was never
   * in danger; the sentence had simply outlived the design.** (R85: a comment is an
   * assertion about code, and a stale one costs more than no comment.)
   */
  it('is located and resolvable, and the range still covers the ENCODED text', () => {
    const source = '<img src="/gallery/a&amp;b.png">';
    const reference = only(html(source));

    expect(reference.ceiling).toBe('high');
    expect(reference.rawPath).toBe('/gallery/a&amp;b.png');
    expect(source.slice(reference.start, reference.end)).toBe(reference.rawPath);
  });

  it('stays unsafe when the entity is one the decoder does not know', () => {
    // The control for the assertion above: promoting the ceiling means a lookup, and a
    // lookup that misses becomes a `broken` finding. A path we cannot fully decode is
    // refused rather than guessed at.
    expect(only(html('<img src="/gallery/caf&eacute;.png">')).ceiling).toBe('unsafe');
  });
});
