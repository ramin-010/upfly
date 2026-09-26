/**
 * What the static text of an assembled path proves, and what it does not.
 *
 * Three rules share this file because they ask one question: given only the literal
 * characters between the unknown segments, what can be concluded? `assembledPathIsGlobbable`
 * asks whether enough is fixed to glob, `provablyNotAFile` whether it could be a file at
 * all, and `splitPathSuffix` where the path stops. Keeping them together stops a fourth
 * from being written elsewhere with its own opinion.
 *
 * The glob rule sets both a template's shape and its ceiling, and only the ceiling changes
 * what the resolver does, so both come from this one function. `shape-ladder.test.ts`
 * asserts each through a real adapter.
 */

import { describe, expect, it } from 'vitest';
import {
  assembledPathIsGlobbable,
  provablyNotAFile,
  spell,
  spellingsOf,
  splitPathSuffix,
  staticExtensionOf,
} from './reference-path.js';

/**
 * The rule, asked with a path rather than a chunk array, because a table of
 * `['', '/b-', '.png']` is unreadable and an unreadable table is how a case gets
 * written wrong.
 */
function globbable(path: string): boolean {
  return assembledPathIsGlobbable(path.split(/\$\{[^}]*\}/));
}

describe('assembledPathIsGlobbable', () => {
  describe('condition 1: the directory must be fixed', () => {
    it.each([
      ['a leading interpolation', '${base}/hero.png'],
      ['a leading interpolation with a fixed name', '${ASSET_BASE}/${name}.png'],
      ['nothing static at all', '${everything}'],
    ])('%s is not globbable', (_name, path) => {
      expect(globbable(path)).toBe(false);
    });
  });

  describe('condition 2: enough of the name must be fixed', () => {
    it('accepts one unknown segment in the name', () => {
      expect(globbable('/theme-${mode}.png')).toBe(true);
      expect(globbable('/srcset/tile@${density}x.png')).toBe(true);
    });

    it('refuses two unknown segments in the name', () => {
      // `dynamic`: the directory is fixed but the name is not. `/icons/*-*.png` constrains
      // almost nothing, so claiming its matches would claim assets nobody referenced.
      expect(globbable('/icons/${theme}-${size}.png')).toBe(false);
    });

    it('refuses three, so the bound is a bound and not an off-by-one', () => {
      expect(globbable('/img/${a}-${b}-${c}.png')).toBe(false);
    });
  });

  describe('unknowns in a directory segment are not unknowns in the name', () => {
    it('counts only what follows the last slash', () => {
      // Two interpolations, one of them a directory. The name has one unknown, so the
      // glob is still anchored by a filename pattern.
      expect(globbable('/img/${dir}/hero-${size}.png')).toBe(true);
    });

    it('accepts a fully fixed name after a varying directory segment', () => {
      expect(globbable('/img/${dir}/hero.png')).toBe(true);
    });
  });

  describe('the degenerate inputs, stated rather than assumed', () => {
    it('treats a path with no unknown segments as globbable', () => {
      expect(assembledPathIsGlobbable(['/img/hero.png'])).toBe(true);
    });

    it('refuses an empty chunk list rather than throwing', () => {
      expect(assembledPathIsGlobbable([])).toBe(false);
    });
  });
});

describe('provablyNotAFile', () => {
  describe('rules on what the text proves', () => {
    const proven: ReadonlyArray<[path: string, matcher: RegExp]> = [
      ['/scratch2/${projectId}/adminpanel/', /directory/],
      ['/scratch2-studios/${studioId}/adminpanel/', /directory/],
      ['/img/${dir}/', /directory/],
      ['/', /directory/],
      ['?a=${b}&c=${d}', /query string/],
      ['/projects/${id}/#fullscreen', /fragment/],
    ];

    for (const [path, matcher] of proven) {
      it(`refuses ${path}`, () => {
        expect(provablyNotAFile(path)).toMatch(matcher);
      });
    }
  });

  describe('rules on nothing else, however obvious the answer looks to a person', () => {
    const kept: readonly string[] = [
      // A route, but `item.name` could end in `.png`.
      '/view/${styleName}/${item.name}',
      // An embed URL. It does not end in `/`, so nothing in the text proves it.
      '${process.env.IDEAS_GENERATOR_SOURCE}/embed',
      // An i18n message id. `${type}` could be `png`, making `report.png`.
      'report.${type}',
      // A query-parameter list joined with `&`, but the `?` that would prove it is inside
      // the const `prefix`, where the static text cannot see it.
      '${prefix}&${formTitle}&${username}',
      // A fragment on the end still leaves a path: `/docs/${page}#section` has the path
      // part `/docs/${page}`, which could be `/docs/hero.png`, and `sprite.svg#icon` is the
      // usual way to reference one symbol in a sprite sheet. The rule fires only when the
      // last segment is the fragment, so nothing of a file name is left.
      '/docs/${page}#section',
      'sprite.svg#icon',
      // Ordinary paths.
      '/gallery/hero.png',
      '/img/${name}.png',
      'hero.${ext}',
      '',
    ];

    for (const path of kept) {
      it(`keeps ${JSON.stringify(path)}`, () => {
        expect(provablyNotAFile(path)).toBeNull();
      });
    }
  });

  /**
   * `#{`, `${` and `@{` open an unknown segment. Reading that `#` as a fragment marker
   * would drop a real SCSS reference.
   */
  it('does not read an interpolation opener as a fragment', () => {
    expect(provablyNotAFile('/img/#{$mode}.png')).toBeNull();
    expect(provablyNotAFile('#{$dir}/hero.png')).toBeNull();
    expect(provablyNotAFile('@{theme}.png')).toBeNull();
    expect(provablyNotAFile('${base}.png')).toBeNull();
  });
});

/**
 * An optional chain inside a template hole is not the start of a query string, and
 * `#{$mode}` in SCSS is not a fragment. Split there, the extension goes with the discarded
 * half. `staticExtensionOf` splits first, so it would see `styles/${config` with no
 * extension, and the resolver could not use the `.json` two segments later to rule the
 * reference out. Both directions are tested here.
 */
describe('a delimiter inside an unknown segment is not a delimiter', () => {
  const cases: ReadonlyArray<[name: string, raw: string, path: string, suffix: string]> = [
    [
      'an optional chain inside a template hole',
      'styles/${config?.style ?? "new-york-v4"}/${item}.json',
      'styles/${config?.style ?? "new-york-v4"}/${item}.json',
      '',
    ],
    ['a SCSS interpolation', '/theme-#{$mode}.png', '/theme-#{$mode}.png', ''],
    ['a Less interpolation', '/theme-@{mode}.png', '/theme-@{mode}.png', ''],
    ['a Handlebars expression', '/img/{{ name }}.png', '/img/{{ name }}.png', ''],
    ['a Nunjucks tag', '/img/{% if x %}a{% endif %}.png', '/img/{% if x %}a{% endif %}.png', ''],
    // A real suffix still splits, holes or not.
    ['a real query after a hole', '/img/${name}.png?v=2', '/img/${name}.png', '?v=2'],
    ['a real fragment after a hole', '/img/${name}.svg#icon', '/img/${name}.svg', '#icon'],
    ['a real query with no hole', 'hero.png?v=2', 'hero.png', '?v=2'],
  ];

  for (const [name, raw, path, suffix] of cases) {
    it(`splits ${name} correctly`, () => {
      expect(splitPathSuffix(raw)).toEqual({ path, suffix });
    });
  }

  it('lets the extension filter see an extension it could not see before', () => {
    expect(staticExtensionOf('styles/${config?.style ?? "x"}/${item}.json')).toBe('.json');
    // An extension a hole hides stays hidden: unknown is not ruled out.
    expect(staticExtensionOf('src/app/layout.${ext}')).toBe('');
  });
});

/**
 * Decode before deciding, and keep the range on the text as written. The literal spelling
 * comes first because `enc%20name.png` can be a file whose name holds a percent sign. See
 * "Percent-encoded and entity-encoded paths" in ARCHITECTURE.md.
 */
describe('spellingsOf', () => {
  it('always offers the literal spelling first', () => {
    expect(spellingsOf('/gallery/hero.png')).toEqual([
      { spelling: 'literal', path: '/gallery/hero.png' },
    ]);
  });

  it('offers the percent-decoded spelling after the literal one', () => {
    expect(spellingsOf('/gallery/hero%20image.png')).toEqual([
      { spelling: 'literal', path: '/gallery/hero%20image.png' },
      { spelling: 'percent-encoded', path: '/gallery/hero image.png' },
    ]);
  });

  it('decodes every character-reference form', () => {
    for (const written of ['a&amp;b.png', 'a&#38;b.png', 'a&#x26;b.png', 'a&#X26;b.png']) {
      expect(spellingsOf(written).map((candidate) => candidate.path)).toContain('a&b.png');
    }
  });

  /**
   * A path that cannot be fully decoded offers no decoded spelling at all. A lookup that
   * misses falls through to `broken`, and a false `broken` is the one outcome the engine
   * promises never to produce, so `&eacute;` stays unreadable rather than becoming a wrong
   * answer.
   */
  it('offers nothing decoded when one reference is outside the bound', () => {
    expect(spellingsOf('caf&eacute;.png').map((candidate) => candidate.spelling)).toEqual([
      'literal',
    ]);
  });

  it('offers nothing decoded when the percent-encoding is malformed', () => {
    // `decodeURIComponent` throws on these rather than returning anything.
    expect(spellingsOf('100%.png').map((candidate) => candidate.spelling)).toEqual(['literal']);
    expect(spellingsOf('a%ZZb.png').map((candidate) => candidate.spelling)).toEqual(['literal']);
  });

  it('leaves a bare ampersand alone: `c&s.png` is a real filename in the corpus', () => {
    expect(spellingsOf('/images/c&s.png').map((candidate) => candidate.spelling)).toEqual([
      'literal',
    ]);
  });
});

/**
 * The other half of decoding. `relocate` builds a reference's new text from the path on
 * disk, so without re-encoding, a file called `hero image.png` would be written back with
 * a raw space inside a URL.
 */
describe('spell', () => {
  it('re-encodes a percent-spelled path per segment, leaving the slashes alone', () => {
    expect(spell('gallery/hero image.avif', 'percent-encoded')).toBe('gallery/hero%20image.avif');
    expect(spell('gallery/hero image (2) copy.avif', 'percent-encoded')).toBe(
      'gallery/hero%20image%20(2)%20copy.avif',
    );
  });

  it('re-encodes an entity-spelled path', () => {
    expect(spell('gallery/a&b.avif', 'html-entities')).toBe('gallery/a&amp;b.avif');
  });

  it('leaves a literal path exactly as it is', () => {
    expect(spell('gallery/hero image.avif', 'literal')).toBe('gallery/hero image.avif');
  });

  it('round-trips: every decoded spelling re-encodes to something that decodes back', () => {
    for (const written of ['/g/hero%20image.png', '/g/a&amp;b.png']) {
      for (const { spelling, path } of spellingsOf(written)) {
        if (spelling === 'literal') continue;
        const respelled = spell(path, spelling);
        expect(spellingsOf(respelled).map((c) => c.path)).toContain(path);
      }
    }
  });
});

/**
 * A `#` inside a character reference is not a fragment delimiter. Split there,
 * `/gallery/a&#38;b.png` would leave `/gallery/a&`, which has no extension, so the resolver
 * would drop it while the named form `a&amp;b.png` still resolved.
 */
describe('a delimiter inside a character reference is not a delimiter', () => {
  const cases: ReadonlyArray<[raw: string, path: string, suffix: string]> = [
    ['/gallery/a&#38;b.png', '/gallery/a&#38;b.png', ''],
    ['/gallery/a&#x26;b.png', '/gallery/a&#x26;b.png', ''],
    ['/gallery/a&amp;b.png', '/gallery/a&amp;b.png', ''],
    // A real fragment after a reference still splits.
    ['/gallery/a&#38;b.svg#icon', '/gallery/a&#38;b.svg', '#icon'],
    // And a real query.
    ['/gallery/a&#38;b.png?v=2', '/gallery/a&#38;b.png', '?v=2'],
  ];

  for (const [raw, path, suffix] of cases) {
    it(`splits ${raw} correctly`, () => {
      expect(splitPathSuffix(raw)).toEqual({ path, suffix });
    });
  }

  it('lets the extension filter see the extension again', () => {
    expect(staticExtensionOf('/gallery/a&#38;b.png')).toBe('.png');
  });
});
