import { describe, expect, it } from 'vitest';
import { IMAGE_EXTENSIONS } from '../paths.js';
import type { RawReference } from '../types.js';
import { htmlAdapter } from './html.js';
import { javascriptAdapter } from './javascript.js';
import { whyFormatKept } from './shapes.js';
import {
  type ClaimedElement,
  URL_POSITIONS,
  type UrlPosition,
  urlPosition,
} from './url-attributes.js';

/**
 * The list is the contract between the two adapters: the same markup, read as a page and as
 * a component, names the same paths at the same offsets. A position added to the list is
 * tested here in both adapters without a test of its own.
 */

/**
 * Attributes that make each claim hold, keyed by tag and attribute. An anchor's claim reads
 * its own value, which the markup below already spells as an image.
 */
const CLAIMING: Readonly<Record<string, string>> = {
  'link href': 'rel="icon"',
  'meta content': 'property="og:image"',
  'a href': '',
};

/** Tags written as markup spells them, where that differs from the lowercase key. */
const WRITTEN: Readonly<Record<string, string>> = { feimage: 'feImage' };

/** Outside an `<svg>` the HTML parser reads `<image>` as `<img>`, so these sit inside one. */
const SVG_TAGS: ReadonlySet<string> = new Set(['image', 'feimage']);

function nameOf(position: UrlPosition): string {
  return `${position.tag} ${position.attribute}`;
}

function markup(position: UrlPosition, around = ''): string {
  const url = position.html === 'srcset' ? '/img/a.png 1x, /img/b.png 2x' : '/img/a.png';
  const value = `${around}${url}${around}`;
  const extra = typeof position.html === 'function' ? CLAIMING[nameOf(position)] : undefined;
  const claim = extra === undefined || extra === '' ? '' : ` ${extra}`;
  const element = `<${WRITTEN[position.tag] ?? position.tag}${claim} ${position.attribute}="${value}" />`;
  return SVG_TAGS.has(position.tag) ? `<svg>${element}</svg>` : element;
}

function located(references: readonly RawReference[]) {
  return references.map(({ rawPath, start, end }) => ({ rawPath, start, end }));
}

describe('every position in the shared list', () => {
  it.each(URL_POSITIONS.map((position) => [nameOf(position), position] as const))(
    'reads %s in a page and in a component at the same offsets',
    (_name, position) => {
      const text = markup(position);
      const page = htmlAdapter.findReferences({ file: '/project/page.html', text });
      const component = javascriptAdapter.findReferences({ file: '/project/Page.jsx', text });

      expect(located(page).length).toBeGreaterThan(0);
      expect(located(component)).toEqual(located(page));
    },
  );

  it.each(URL_POSITIONS.map((position) => [nameOf(position), position] as const))(
    'reads %s with whitespace around the value in a page and in a component alike',
    (_name, position) => {
      // A browser strips the C0 controls and spaces around a URL before it reads it.
      const text = markup(position, '\n  ');
      const page = htmlAdapter.findReferences({ file: '/project/page.html', text });
      const component = javascriptAdapter.findReferences({ file: '/project/Page.jsx', text });

      expect(located(page).length).toBeGreaterThan(0);
      expect(located(component)).toEqual(located(page));
    },
  );

  it('has an example here for every claim, so no claimed position goes untested', () => {
    const untested = URL_POSITIONS.filter(
      (position) => typeof position.html === 'function' && CLAIMING[nameOf(position)] === undefined,
    ).map(nameOf);
    expect(untested).toEqual([]);
  });

  it('holds each tag and attribute once, so a lookup cannot miss a second row', () => {
    const names = URL_POSITIONS.map(nameOf);
    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps the format at a position in both adapters or in neither', () => {
    // The planner reads the rule from the shape, so a position whose two shapes disagreed
    // would be rewritten in a page and left alone in a component, or the other way round.
    for (const position of URL_POSITIONS) {
      const html = htmlShapeOf(position);
      const kept = [html, position.jsx].map(
        (shape) => shape !== null && whyFormatKept(shape) !== null,
      );
      expect(kept[0], nameOf(position)).toBe(kept[1]);
    }
  });
});

/** The HTML shape a position gives the example markup above, or `null` for a list. */
function htmlShapeOf(position: UrlPosition): string | null {
  if (position.html === 'srcset') return null;
  if (typeof position.html !== 'function') return position.html;
  const attributes: Record<string, string> = {};
  for (const [, name = '', value = ''] of (CLAIMING[nameOf(position)] ?? '').matchAll(
    /([\w:-]+)="([^"]*)"/g,
  )) {
    attributes[name] = value;
  }
  return position.html(element(attributes, '/img/a.png'));
}

/** An element holding these other attributes, its judged value spelled `value`. */
function element(
  attributes: Readonly<Record<string, string>>,
  value: string | null = null,
): ClaimedElement {
  return { attribute: (name) => attributes[name], valueText: () => value };
}

describe('urlPosition', () => {
  const none = element({});

  it('answers a fixed position without asking the element', () => {
    expect(urlPosition('img', 'src', none)).toEqual({
      html: 'html.img.src',
      jsx: 'js.jsx.attribute',
    });
  });

  it('settles a claim from the attributes beside the one it judges', () => {
    expect(urlPosition('link', 'href', element({ rel: 'shortcut icon' }))?.html).toBe(
      'html.link.href.icon',
    );
    expect(urlPosition('link', 'href', element({ rel: 'stylesheet' }))).toBeNull();
    expect(urlPosition('link', 'href', none)).toBeNull();
  });

  it('knows nothing of an attribute no position lists', () => {
    expect(urlPosition('img', 'alt', none)).toBeNull();
    expect(urlPosition('div', 'src', none)).toBeNull();
  });
});

describe('a meta tag names an image under a link-preview name', () => {
  it.each([
    ['property', 'og:image'],
    ['property', 'og:image:url'],
    ['property', 'og:image:secure_url'],
    ['name', 'twitter:image'],
    ['name', 'twitter:image:src'],
    ['name', 'msapplication-TileImage'],
    ['property', 'OG:IMAGE'],
    ['name', 'og:image'],
  ])('claims content when %s is %s', (attribute, value) => {
    expect(urlPosition('meta', 'content', element({ [attribute]: value }))).toEqual({
      html: 'html.meta.content.image',
      jsx: 'js.jsx.meta.content.image',
    });
  });

  it.each([
    ['a description', { name: 'description' }],
    ['a preview title', { property: 'og:title' }],
    ['a tile colour', { name: 'msapplication-TileColor' }],
    ['no name at all', {}],
  ])('claims nothing for %s, whatever its content spells', (_name, attributes) => {
    expect(urlPosition('meta', 'content', element(attributes, '/img/logo.png'))).toBeNull();
  });
});

describe('a link names an image when its value spells an image extension', () => {
  it.each([
    ['a plain path', '/img/team.jpg'],
    ['an uppercase extension', '/gallery/Banner.PNG'],
    ['a query after the extension', '/img/team.jpg?download=1'],
    ['a template hole in the name', '/img/${}.png'],
    ['a percent-encoded dot', '/img/hero%2Epng'],
    ['a character reference for the dot', '/img/hero&#46;png'],
    ['a vector', '/icons/mask.svg'],
    ['a vector with an uppercase extension', '/img/Diagram.SVG'],
  ])('claims %s', (_name, value) => {
    expect(urlPosition('a', 'href', element({}, value))).toEqual({
      html: 'html.a.href.image',
      jsx: 'js.jsx.a.href.image',
    });
  });

  it.each(IMAGE_EXTENSIONS)(
    'claims every extension the engine counts as an image, %s among them',
    (extension) => {
      // A vector is never converted, but a link is what shows it is used, so the claim takes
      // every image extension, not only the ones `optimize` converts.
      expect(urlPosition('a', 'href', element({}, `/files/picture${extension}`))?.html).toBe(
        'html.a.href.image',
      );
    },
  );

  it.each([
    ['a page', '/about'],
    ['a document', '/files/report.pdf'],
    ['an extension a hole hides', '/img/hero.${}'],
    ['a script that serves an image', '/download?file=team.jpg'],
  ])('claims nothing for %s', (_name, value) => {
    expect(urlPosition('a', 'href', element({}, value))).toBeNull();
  });

  it('claims nothing for a value with no text of its own', () => {
    expect(urlPosition('a', 'href', element({}, null))).toBeNull();
  });
});

describe('a vector at a position that keeps the format', () => {
  // An SVG named only here would otherwise be counted unused while a page links to it.
  it.each([
    ['a link', '<a href="/icons/mask.svg">x</a>', 'html.a.href.image', 'js.jsx.a.href.image'],
    [
      'a link preview',
      '<meta property="og:image" content="/icons/mask.svg" />',
      'html.meta.content.image',
      'js.jsx.meta.content.image',
    ],
  ])('is read at %s, in a page and in a component', (_name, text, pageShape, componentShape) => {
    const page = htmlAdapter.findReferences({ file: '/project/page.html', text });
    const component = javascriptAdapter.findReferences({ file: '/project/Page.jsx', text });

    expect(page.map(({ rawPath, shape }) => [rawPath, shape])).toEqual([
      ['/icons/mask.svg', pageShape],
    ]);
    expect(component.map(({ rawPath, shape }) => [rawPath, shape])).toEqual([
      ['/icons/mask.svg', componentShape],
    ]);
    expect(located(component)).toEqual(located(page));
  });
});
