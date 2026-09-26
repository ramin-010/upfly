/**
 * The two disposition shapes, `path.bare-specifier` and `path.charref`. A disposition names
 * how the path is written, which is what would take the reference out, so it is the same in
 * every host and takes precedence over the construct the path sits in. See "How a shape is
 * chosen" in ARCHITECTURE.md.
 *
 * A bare specifier has one shape in an `import`, an `import()` and a `require()`, so one
 * predicate has one matrix row rather than three.
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

describe('path.bare-specifier: the disposition beats the construct', () => {
  it.each([
    ['a static import', "import logo from 'some-ui-kit/dist/logo.png';"],
    ['a dynamic import', "const m = await import('some-ui-kit/dist/logo.png');"],
    ['require()', "const logo = require('some-ui-kit/dist/logo.png');"],
  ])('claims %s as path.bare-specifier', (_name, source) => {
    expect(only(js(source)).shape).toBe('path.bare-specifier');
  });

  it('does not claim the identical text in a plain string, and that is measured', () => {
    // In an ordinary string the prefix test decides nothing: `some-ui-kit/dist/x.png` and
    // `src/assets/x.png` are the same syntax, and only `node_modules` separates them.
    // Claiming it would label strings such as `loading...` and `v2.0.0` as packages, so the
    // shape declares `adapterEmitsAs` for the key's plain-string entry instead.
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

  it('does not apply to new URL(…, import.meta.url), where a bare path is relative', () => {
    // The same spelling with the opposite meaning, decided entirely by the construct:
    // `new URL('img.png', import.meta.url)` resolves against the module, so calling it
    // a package would report a real, rewritable asset as out of scope.
    const source = "const u = new URL('img.png', import.meta.url);";

    expect(only(js(source)).shape).toBe('js.new-url');
  });

  it('leaves an alias-shaped specifier to the construct, because the table is elsewhere', () => {
    // `@scope/pkg/x.png` and an `@img/*` tsconfig alias are the same syntax. Telling them
    // apart needs the paths table, which only the resolver has, so the adapter claims neither.
    for (const prefix of ['~', '@', '#']) {
      const source = `import art from '${prefix}img/aliased.png';`;
      expect(only(js(source)).shape, prefix).toBe('js.import.static');
    }
  });
});

describe('path.charref: the spelling beats the construct', () => {
  it('claims a character-referenced img@src as path.charref', () => {
    expect(only(html('<img src="/gallery/a&amp;b.png">')).shape).toBe('path.charref');
  });

  it('claims it in an feImage too, rather than as the construct it sits in', () => {
    // "The narrowest thing that breaks alone" cannot settle this: both `html.svg.feimage`
    // and the charref decoding take other entries with them. The disposition takes
    // precedence, and the adapter checks for character references before it picks a host
    // shape.
    const source = '<svg><filter><feImage xlink:href="/gallery/a&amp;b.png" /></filter></svg>';

    expect(only(html(source)).shape).toBe('path.charref');
  });

  it('leaves the same feImage on its construct when the path has no entity', () => {
    // The control: without it the assertion above would pass with feImage support
    // deleted outright.
    const source = '<svg><filter><feImage xlink:href="/img/texture.png" /></filter></svg>';

    expect(only(html(source)).shape).toBe('html.svg.feimage');
  });

  // An escaped path can be resolved and rewritten: `rawPath` is the encoded source text,
  // the range covers exactly that text, and `relocate` re-encodes the path it writes.
  it('is located and resolvable, and the range still covers the encoded text', () => {
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
