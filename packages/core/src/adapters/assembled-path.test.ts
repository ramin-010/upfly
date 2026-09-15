/**
 * What the STATIC TEXT of an assembled path proves, and what it does not.
 *
 * Three rules share this file because they are one question asked three ways — *given
 * only the literal characters between the unknown segments, what can be concluded?*
 * R80(b) asks whether enough is fixed to glob; R108 asks whether anything could be a
 * file at all; the delimiter tests ask where the path stops. Keeping them together is
 * what stops the fourth one being written somewhere else with its own opinion, which is
 * precisely how R89 and R106 happened.
 *
 * ── R80(b)'s rule, which had been ruled and implemented nowhere.
 *
 * 🔴 **The test that would have failed, and the reason it did not exist.** Until R89 the
 * decision lived in `templateShape`, which asked only *“does the static prefix contain a
 * `/`”* — condition ONE of two. `/icons/${theme}-${size}.png` passed it, so the engine
 * called it a `pattern` while the ruled answer is `dynamic`, and a pattern claims files:
 * globbing it would sweep in `icon-192.png` and `icon-512.png` on a template that
 * constrains almost nothing.
 *
 * ⚠️ **The second reason to test it here rather than through an adapter.** The rule now
 * decides two different things about the same reference — its SHAPE (`templateShape`) and
 * its CEILING (`addTemplateReference`) — and only the ceiling changes behaviour. Getting
 * the two from one function is what stops a future relabelling from looking like a fix
 * again. Each is asserted against a real adapter in `shape-ladder.test.ts`.
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
 * written wrong. Splitting lives here rather than in shipped code: the engine's
 * callers already hold the chunks (a template literal's `quasis`), so a shipped
 * splitter would have had no consumer but this file.
 */
function globbable(path: string): boolean {
  return assembledPathIsGlobbable(path.split(/\$\{[^}]*\}/));
}

describe('assembledPathIsGlobbable', () => {
  describe('condition 1 — the directory must be fixed (R78 Q3)', () => {
    it.each([
      ['a leading interpolation', '${base}/hero.png'],
      ['a leading interpolation with a fixed name', '${ASSET_BASE}/${name}.png'],
      ['nothing static at all', '${everything}'],
    ])('%s is not globbable', (_name, path) => {
      expect(globbable(path)).toBe(false);
    });
  });

  describe('condition 2 — enough of the NAME must be fixed (R80(b))', () => {
    it('accepts one unknown segment in the name', () => {
      expect(globbable('/theme-${mode}.png')).toBe(true);
      expect(globbable('/srcset/tile@${density}x.png')).toBe(true);
    });

    it('🔴 REFUSES two unknown segments in the name — the case R80(b) ruled', () => {
      // The ruled answer is `dynamic`. The directory is fixed and the name is not:
      // `/icons/*-*.png` constrains almost nothing, so claiming its matches would
      // claim assets nobody referenced.
      expect(globbable('/icons/${theme}-${size}.png')).toBe(false);
    });

    it('refuses three, so the bound is a bound and not an off-by-one', () => {
      expect(globbable('/img/${a}-${b}-${c}.png')).toBe(false);
    });
  });

  describe('unknowns in a DIRECTORY segment are not unknowns in the name', () => {
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
  describe('rules on what the text PROVES', () => {
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

  describe('🔴 rules on nothing else, however obvious the answer looks to a person', () => {
    const kept: readonly string[] = [
      // R108's worked example. A route, and `item.name` could end in `.png`.
      '/view/${styleName}/${item.name}',
      // An embed URL. It does not end in `/`, so nothing in the text proves it.
      '${process.env.IDEAS_GENERATOR_SOURCE}/embed',
      // An i18n message id. `${type}` could be `png`, making `report.png`.
      'report.${type}',
      // A query-parameter list joined with `&` — and the `?` that would prove it is
      // inside the const `prefix`, where the static text cannot see it.
      '${prefix}&${formTitle}&${username}',
      // 🔴 A FRAGMENT ON THE END IS NOT A FRAGMENT INSTEAD OF A PATH, and this case was
      // in the "proven" table until the run said otherwise. `/docs/${page}#section` has
      // the path part `/docs/${page}`, which could be `/docs/hero.png` — and
      // `sprite.svg#icon` is the ordinary way to reference one symbol in a sprite sheet.
      // The rule fires only when the last segment IS the fragment, so nothing of a
      // filename is left.
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
   * ⚠️ `#{`, `${` and `@{` open an unknown segment. Reading that `#` as a fragment
   * marker would drop a real SCSS reference — B9 made exactly that mistake in the
   * opposite direction and it turned three `dynamic` rows into three `absent` ones.
   */
  it('does not read an interpolation opener as a fragment', () => {
    expect(provablyNotAFile('/img/#{$mode}.png')).toBeNull();
    expect(provablyNotAFile('#{$dir}/hero.png')).toBeNull();
    expect(provablyNotAFile('@{theme}.png')).toBeNull();
    expect(provablyNotAFile('${base}.png')).toBeNull();
  });
});

/**
 * 🔴 A `?` or `#` INSIDE AN UNKNOWN SEGMENT IS NOT A DELIMITER.
 *
 * `splitPathSuffix` searched the raw text, so an optional chain inside a template hole
 * looked like the start of a query string. The damage was downstream and silent:
 * `staticExtensionOf` calls this first, so the path it measured was
 * `styles/${config` — no extension — and `provablyNotAnAsset` could not rule out a
 * `.json` written in plain sight two segments later.
 *
 * ⚠️ B9 made the opposite mistake in the same place: `#` opens a URL fragment in CSS
 * and an interpolation in SCSS, `/theme-#{$mode}.png` was split at the `#`, and the
 * extension went with the discarded half. **Both halves of the ambiguity are one rule
 * now**, and both directions are tested here.
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
    // And an extension genuinely hidden by a hole stays hidden — unknown is not ruled out.
    expect(staticExtensionOf('src/app/layout.${ext}')).toBe('');
  });
});

/**
 * R118 — decode before you decide, and keep the range honest.
 *
 * 🔴 **The pair in the second block is the whole point and it is why an engine cannot
 * simply "support percent-encoding".** `enc%20name.png` is a real file whose NAME contains
 * a percent sign; `hero%20image.png` is a different real file called `hero image.png`. The
 * two are indistinguishable as text. An engine that never decodes gets the second wrong, one
 * that always decodes gets the first wrong, and only literal-then-decoded gets both.
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
   * 🔴 A path we cannot FULLY decode offers no decoded candidate at all, and that is the
   * safety argument for promoting these to a lookup. A lookup that misses does not shrug —
   * it falls through to `broken`, and a false `broken` is the one outcome this project
   * promises never to produce. The bound is stated in `spellingsOf` and is deliberate:
   * `&eacute;` stays unreadable rather than becoming a wrong answer.
   */
  it('offers NOTHING decoded when one reference is outside the bound', () => {
    expect(spellingsOf('caf&eacute;.png').map((candidate) => candidate.spelling)).toEqual([
      'literal',
    ]);
  });

  it('offers nothing decoded when the percent-encoding is malformed', () => {
    // `decodeURIComponent` THROWS here rather than returning anything (R86).
    expect(spellingsOf('100%.png').map((candidate) => candidate.spelling)).toEqual(['literal']);
    expect(spellingsOf('a%ZZb.png').map((candidate) => candidate.spelling)).toEqual(['literal']);
  });

  it('leaves a bare ampersand alone — `c&s.png` is a real filename in the corpus', () => {
    expect(spellingsOf('/images/c&s.png').map((candidate) => candidate.spelling)).toEqual([
      'literal',
    ]);
  });
});

/**
 * 🔴 The half that makes the decode safe to ship. `relocate` builds a reference's new
 * text from the ON-DISK path, so a file genuinely called `hero image.png` would be written
 * back with a raw space inside a URL. Decode and re-encode are one change.
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
 * 🔴 A `#` inside a character reference is not a fragment delimiter, and this cost
 * `path.charref` two of its four entries. `/gallery/a&#38;b.png` split at the `#` of its own
 * numeric reference, leaving `/gallery/a&` — no extension, so rung 3 dropped it. The named
 * form `&amp;` resolved perfectly, which is what made the row look like a partial success
 * rather than one rule missing one encoding.
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
