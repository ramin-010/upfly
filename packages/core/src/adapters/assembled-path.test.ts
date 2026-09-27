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
  TEMPLATE_HOLES,
  assembledPathIsGlobbable,
  decodeMarkdownDestination,
  holdsUndecodableCharacterReference,
  holdsUndecodableMarkdownEscape,
  interpolationChunks,
  isExternalUrl,
  provablyNotAFile,
  spell,
  spellingsOf,
  splitPathSuffix,
  staticExtensionOf,
  templateExpressionReason,
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

describe('isExternalUrl', () => {
  // A letter, a colon and a slash or a backslash is a Windows drive. Read as a URL scheme,
  // `C:/site/hero.png` would be dropped as another host's file, with no report line.
  it.each([
    ['a drive path', 'C:/site/img/hero.png'],
    ['a drive path with backslashes', 'C:\\site\\img\\hero.png'],
    ['a lowercase drive letter', 'd:/photos/hero.png'],
  ])('reads %s as a path in every construct', (_name, path) => {
    for (const kind of ['import', 'attr', 'css-url', 'md', 'json', 'template', 'string'] as const) {
      expect(isExternalUrl(path, kind), kind).toBe(false);
    }
  });

  it.each([
    ['a scheme', 'https://cdn.example.com/hero.png'],
    ['a data URI', 'data:image/png;base64,AAAA'],
    ['a one-letter scheme with no slash after the colon', 'c:hero.png'],
    ['a two-letter scheme', 'ab:/hero.png'],
    ['a protocol-relative URL', '//cdn.example.com/hero.png'],
  ])('still reads %s as a URL', (_name, path) => {
    expect(isExternalUrl(path, 'attr')).toBe(true);
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
 * Every way a path is written with a hole in it. Each rule that reads a path's text has to
 * treat all of them as an unknown part: a syntax one rule misses is a reference that rule
 * drops, splits in the wrong place or reports broken. The body holds a dot and a question
 * mark, which a rule that does not see the hole around them reads as an extension or a
 * query.
 */
const HOLE_SYNTAXES: ReadonlyArray<[syntax: string, opener: string, closer: string]> = [
  ['a Handlebars expression', '{{', '}}'],
  ['a Liquid tag', '{%', '%}'],
  ['an EJS expression', '<%', '%>'],
  ['a template literal expression', '${', '}'],
  ['a SCSS interpolation', '#{', '}'],
  ['a Less interpolation', '@{', '}'],
];

describe.each(HOLE_SYNTAXES)('%s is an unknown part of a path', (_syntax, opener, closer) => {
  const hole = `${opener} a.b ? c : d ${closer}`;

  it('hides the extension when it fills the extension', () => {
    expect(staticExtensionOf(`/img/hero.${hole}`)).toBe('');
  });

  it('leaves an extension written after it visible', () => {
    expect(staticExtensionOf(`/img/${hole}.png`)).toBe('.png');
  });

  it('holds no query or fragment delimiter', () => {
    const path = `/img/${hole}.png`;
    expect(splitPathSuffix(path)).toEqual({ path, suffix: '' });
  });

  it('marks the path as built at render time', () => {
    expect(templateExpressionReason(`/img/${hole}.png`)).not.toBeNull();
  });

  it('is neither a fragment nor an external URL at the start of a segment', () => {
    expect(provablyNotAFile(`/img/${hole}`)).toBeNull();
    expect(isExternalUrl(`${hole}/hero.png`, 'css-url')).toBe(false);
  });
});

describe('TEMPLATE_HOLES', () => {
  it('holds exactly the syntaxes above, so a new one is tested by every rule', () => {
    expect(TEMPLATE_HOLES.map(({ opener, closer }) => [opener, closer])).toEqual(
      HOLE_SYNTAXES.map(([, opener, closer]) => [opener, closer]),
    );
  });

  // A pattern is globbed only when its adapter marked it `medium`, which only the
  // JavaScript, SCSS and Less adapters do, so only their holes split a path into chunks.
  it('globs the JavaScript, SCSS and Less holes and no others', () => {
    expect(interpolationChunks('/img/${a}-#{$b}-@{c}.png')).toEqual(['/img/', '-', '-', '.png']);
    expect(interpolationChunks('/img/{{ a }}-{% b %}-<%= c %>.png')).toHaveLength(1);
  });
});

/**
 * Decode before deciding, and keep the range on the text as written. The literal spelling
 * comes first because `enc%20name.png` can be a file whose name holds a percent sign. See
 * "Percent-encoded and entity-encoded paths" in ARCHITECTURE.md.
 */
describe('spellingsOf', () => {
  it('always offers the literal spelling first', () => {
    expect(spellingsOf('/gallery/hero.png', 'attr')).toEqual([
      { spelling: 'literal', path: '/gallery/hero.png' },
    ]);
  });

  it('offers the percent-decoded spelling after the literal one', () => {
    expect(spellingsOf('/gallery/hero%20image.png', 'attr')).toEqual([
      { spelling: 'literal', path: '/gallery/hero%20image.png' },
      { spelling: 'percent-encoded', path: '/gallery/hero image.png' },
    ]);
  });

  it('decodes every character-reference form', () => {
    for (const written of ['a&amp;b.png', 'a&#38;b.png', 'a&#x26;b.png', 'a&#X26;b.png']) {
      expect(spellingsOf(written, 'attr').map((candidate) => candidate.path)).toContain('a&b.png');
    }
  });

  /**
   * A path that cannot be fully decoded offers no decoded spelling at all, not even with the
   * references that do decode. A lookup that misses falls through to `broken`, and a false
   * `broken` is the one outcome the engine promises never to produce, so a path holding the
   * misspelled `&eacut;` stays unreadable rather than becoming a wrong answer.
   */
  it('offers nothing decoded when one reference is outside the bound', () => {
    expect(
      spellingsOf('a&amp;caf&eacut;.png', 'attr').map((candidate) => candidate.spelling),
    ).toEqual(['literal']);
  });

  /**
   * CommonMark decodes a character reference in a link destination when the HTML
   * specification defines its name (CommonMark 0.31.2, section 2.5), and the resolver tries
   * that decoded spelling. Most cases are the specification's own examples.
   */
  it.each([
    ['/f&ouml;&ouml;', `/f${String.fromCodePoint(0xf6, 0xf6)}`],
    ['caf&eacute;.png', `caf${String.fromCodePoint(0xe9)}.png`],
    ['&copy;&AElig;&Dcaron;&frac34;', String.fromCodePoint(0xa9, 0xc6, 0x10e, 0xbe)],
    ['&HilbertSpace;&ngE;', String.fromCodePoint(0x210b, 0x2267, 0x338)],
    ['&Lt;&LT;&AMP;', String.fromCodePoint(0x226a, 0x3c, 0x26)],
    ['&#35;&#1234;&#X22;&#xcab;', String.fromCodePoint(0x23, 0x4d2, 0x22, 0xcab)],
  ])('decodes %s as CommonMark does', (written, decoded) => {
    expect(spellingsOf(written, 'attr')).toContainEqual({
      spelling: 'html-entities',
      path: decoded,
    });
  });

  it.each([
    'caf&eacut;.png',
    '&notit;',
    '&ThisIsNotDefined;',
    '&MadeUpEntity;',
    '&x;',
    '&Amp;',
    '&APOS;',
    '&copy',
    '&#87654321;',
    '&#abcdef0;',
    '&hi?;',
  ])('offers only the literal spelling of %s, which CommonMark does not decode', (written) => {
    expect(spellingsOf(written, 'attr').map((candidate) => candidate.spelling)).toEqual([
      'literal',
    ]);
  });

  it('offers nothing decoded when the percent-encoding is malformed', () => {
    // `decodeURIComponent` throws on these rather than returning anything.
    expect(spellingsOf('100%.png', 'attr').map((candidate) => candidate.spelling)).toEqual([
      'literal',
    ]);
    expect(spellingsOf('a%ZZb.png', 'attr').map((candidate) => candidate.spelling)).toEqual([
      'literal',
    ]);
  });

  it('leaves a bare ampersand alone: `c&s.png` is a real filename in the corpus', () => {
    expect(spellingsOf('/images/c&s.png', 'attr').map((candidate) => candidate.spelling)).toEqual([
      'literal',
    ]);
  });

  /**
   * CommonMark removes a backslash before ASCII punctuation in a link destination (section
   * 2.4), so in Markdown `my\_photo.png` names `my_photo.png`. Anywhere else the backslash
   * is left as written.
   */
  it('reads the backslash escapes of a Markdown destination and of nothing else', () => {
    expect(spellingsOf('/img/my\\_photo.png', 'md')).toEqual([
      { spelling: 'literal', path: '/img/my\\_photo.png' },
      { spelling: 'markdown-escapes', path: '/img/my_photo.png' },
    ]);
    for (const kind of ['attr', 'import', 'css-url'] as const) {
      expect(spellingsOf('/img/my\\_photo.png', kind), kind).toEqual([
        { spelling: 'literal', path: '/img/my\\_photo.png' },
      ]);
    }
  });

  it('keeps the entity spelling of a Markdown destination that holds no escape', () => {
    expect(spellingsOf('/img/caf&eacute;.png', 'md')).toEqual([
      { spelling: 'literal', path: '/img/caf&eacute;.png' },
      { spelling: 'html-entities', path: `/img/caf${String.fromCodePoint(0xe9)}.png` },
    ]);
    // A backslash before a letter escapes nothing.
    expect(spellingsOf('C:\\site\\hero.png', 'md')).toEqual([
      { spelling: 'literal', path: 'C:\\site\\hero.png' },
    ]);
  });

  it('cannot be asked without a kind, since the kind decides the spellings', () => {
    // @ts-expect-error: without the kind, a Markdown escape would be lost without a word.
    expect(spellingsOf('/img/x.png')).toHaveLength(1);
  });
});

/**
 * CommonMark 0.31.2, sections 2.4 and 2.5: in a link destination a backslash before an ASCII
 * punctuation character is removed, and character references are decoded, in one pass.
 */
describe('decodeMarkdownDestination', () => {
  it('removes the backslash before each ASCII punctuation character', () => {
    // Section 2.4's list of the thirty-two.
    const punctuation = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
    const escaped = [...punctuation].map((character) => `\\${character}`).join('');

    expect(punctuation).toHaveLength(32);
    expect(decodeMarkdownDestination(escaped)).toBe(punctuation);
  });

  it('keeps a backslash before anything else, as written', () => {
    for (const text of ['C:\\site\\hero.png', '\\A\\a\\3\\φ\\«', 'end\\']) {
      expect(decodeMarkdownDestination(text), text).toBe(text);
    }
  });

  it('reads escapes and character references in one pass', () => {
    const cafe = `caf${String.fromCodePoint(0xe9)}`;
    expect(decodeMarkdownDestination('/img/my\\_caf&eacute;.png')).toBe(`/img/my_${cafe}.png`);
    // An escaped ampersand starts no reference, and an escaped backslash escapes nothing.
    expect(decodeMarkdownDestination('/img/\\&eacute;.png')).toBe('/img/&eacute;.png');
    expect(decodeMarkdownDestination('/img/a\\\\_b.png')).toBe('/img/a\\_b.png');
  });

  it('gives no reading when a character reference cannot be decoded', () => {
    expect(decodeMarkdownDestination('/img/caf&eacut;.png')).toBeNull();
  });
});

/** What the markdown adapter asks before it lets a destination be looked up. */
describe('holdsUndecodableCharacterReference', () => {
  it('is true when something written as a reference does not decode', () => {
    expect(holdsUndecodableCharacterReference('caf&eacut;.png')).toBe(true);
    expect(holdsUndecodableCharacterReference('caf&#x110000;.png')).toBe(true);
  });

  // The file is `caf` with an accent then ` x.png`, which no spelling the resolver tries
  // reaches: it decodes the reference or the escape, never both.
  it('is true for a reference beside a percent-escape', () => {
    expect(holdsUndecodableCharacterReference('caf&eacute;%20x.png')).toBe(true);
  });

  it('is false for a path that decodes, or that holds no reference at all', () => {
    expect(holdsUndecodableCharacterReference('caf&eacute;.png')).toBe(false);
    expect(holdsUndecodableCharacterReference('c&s.png')).toBe(false);
    expect(holdsUndecodableCharacterReference('hero%20image.png')).toBe(false);
    expect(holdsUndecodableCharacterReference('hero.png')).toBe(false);
  });
});

/** The same question for a Markdown destination, whose backslash escapes are read too. */
describe('holdsUndecodableMarkdownEscape', () => {
  // Each names its file only after both decodings: `my\_photo%20x.png` is `my_photo x.png`,
  // and `my\%20photo.png` reads `my%20photo.png`, which a server decodes to `my photo.png`.
  it('is true for a backslash escape beside a percent-escape', () => {
    expect(holdsUndecodableMarkdownEscape('/img/my\\_photo%20x.png')).toBe(true);
    expect(holdsUndecodableMarkdownEscape('/img/my\\%20photo.png')).toBe(true);
  });

  it('is false for an ampersand a backslash escapes, which starts no reference', () => {
    expect(holdsUndecodableMarkdownEscape('/img/\\&eacut;.png')).toBe(false);
    expect(holdsUndecodableMarkdownEscape('/img/my\\_photo.png')).toBe(false);
  });

  it('answers as holdsUndecodableCharacterReference for a path with no escape', () => {
    for (const path of [
      'caf&eacut;.png',
      'caf&#x110000;.png',
      'caf&eacute;%20x.png',
      'caf&eacute;.png',
      'my\\photo.png',
      'hero%20image.png',
      'hero.png',
    ]) {
      expect(holdsUndecodableMarkdownEscape(path), path).toBe(
        holdsUndecodableCharacterReference(path),
      );
    }
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

  it('escapes only a backslash and an ampersand in a Markdown-escaped path', () => {
    expect(spell('img/my_photo.avif', 'markdown-escapes')).toBe('img/my_photo.avif');
    expect(spell('img/a&amp;b\\_c.avif', 'markdown-escapes')).toBe('img/a\\&amp;b\\\\_c.avif');
  });

  it('leaves a literal path exactly as it is', () => {
    expect(spell('gallery/hero image.avif', 'literal')).toBe('gallery/hero image.avif');
  });

  it('round-trips: every decoded spelling re-encodes to something that decodes back', () => {
    for (const written of ['/g/hero%20image.png', '/g/a&amp;b.png']) {
      for (const { spelling, path } of spellingsOf(written, 'attr')) {
        if (spelling === 'literal') continue;
        const respelled = spell(path, spelling);
        expect(spellingsOf(respelled, 'attr').map((c) => c.path)).toContain(path);
      }
    }
  });

  it('round-trips a Markdown-escaped path through the reading CommonMark gives it', () => {
    const written = '/g/my\\_a\\&amp;b\\\\c.png';
    const decoded = spellingsOf(written, 'md').find(
      ({ spelling }) => spelling === 'markdown-escapes',
    );

    expect(decoded?.path).toBe('/g/my_a&amp;b\\c.png');
    const respelled = spell(decoded?.path ?? '', 'markdown-escapes');
    expect(spellingsOf(respelled, 'md').map((c) => c.path)).toContain(decoded?.path);
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
