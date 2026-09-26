import { describe, expect, it } from 'vitest';
import type { RawReference } from '../types.js';
import { htmlAdapter } from './html.js';
import { javascriptAdapter } from './javascript.js';
import { URL_POSITIONS, type UrlPosition, urlPosition } from './url-attributes.js';

/**
 * The list is the contract between the two adapters: the same markup, read as a page and as
 * a component, names the same paths at the same offsets. A position added to the list is
 * tested here in both adapters without a test of its own.
 */

/** Attributes that make each claim hold, keyed by tag and attribute. */
const CLAIMING: Readonly<Record<string, string>> = {
  'link href': 'rel="icon"',
};

/** Tags written as markup spells them, where that differs from the lowercase key. */
const WRITTEN: Readonly<Record<string, string>> = { feimage: 'feImage' };

/** Outside an `<svg>` the HTML parser reads `<image>` as `<img>`, so these sit inside one. */
const SVG_TAGS: ReadonlySet<string> = new Set(['image', 'feimage']);

function nameOf(position: UrlPosition): string {
  return `${position.tag} ${position.attribute}`;
}

function markup(position: UrlPosition): string {
  const value = position.html === 'srcset' ? '/img/a.png 1x, /img/b.png 2x' : '/img/a.png';
  const claim = typeof position.html === 'function' ? ` ${CLAIMING[nameOf(position)] ?? ''}` : '';
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
});

describe('urlPosition', () => {
  const none = { attribute: () => undefined };

  it('answers a fixed position without asking the element', () => {
    expect(urlPosition('img', 'src', none)).toEqual({
      html: 'html.img.src',
      jsx: 'js.jsx.attribute',
    });
  });

  it('settles a claim from the attributes beside the one it judges', () => {
    const rel = (value: string) => ({
      attribute: (name: string) => (name === 'rel' ? value : undefined),
    });
    expect(urlPosition('link', 'href', rel('shortcut icon'))?.html).toBe('html.link.href.icon');
    expect(urlPosition('link', 'href', rel('stylesheet'))).toBeNull();
    expect(urlPosition('link', 'href', none)).toBeNull();
  });

  it('knows nothing of an attribute no position lists', () => {
    expect(urlPosition('img', 'alt', none)).toBeNull();
    expect(urlPosition('div', 'src', none)).toBeNull();
  });
});
