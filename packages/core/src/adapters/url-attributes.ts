/**
 * The attributes that hold a URL, as one list the HTML adapter and the JSX reader of the
 * JavaScript adapter both read, so an attribute names a file in a component exactly where it
 * does in a page.
 *
 * A position is a tag, an attribute and, where those two do not decide, a claim read from the
 * rest of the element: a `<link href>` names an image only when its `rel` says it is an icon
 * or a preloaded image. See "The six that exist" in ARCHITECTURE.md.
 */

import type { ShapeId } from '../shapes.js';

/** What a claim may read of the element whose attribute it judges. */
export interface ClaimedElement {
  /**
   * The value of another attribute on the element, by lowercase name, or `undefined` when
   * the element has none or its value is not plain text.
   */
  attribute(name: string): string | undefined;
}

/**
 * Whether an element's attribute names a file, answered as the shape the HTML adapter gives
 * that reference, or `null` when it names none.
 *
 * A shape rather than a boolean, because one claim can assert two things that fail apart:
 * an icon and a preloaded image each have their own shape.
 */
export type Claim = (element: ClaimedElement) => ShapeId | null;

/** One attribute that holds a URL on one tag. */
export interface UrlPosition {
  /**
   * The tag, lowercase. The HTML parser spells one element `feImage`, following the
   * specification's table for SVG tag names, so both adapters lowercase a tag before looking.
   */
  readonly tag: string;
  /** The attribute, lowercase, with a namespace written as in markup (`xlink:href`). */
  readonly attribute: string;
  /**
   * What the HTML adapter emits here: a shape, `srcset` for a candidate list whose
   * candidates take their shapes from their descriptors, or a claim that decides from the
   * element whether the value names a file at all.
   */
  readonly html: ShapeId | 'srcset' | Claim;
  /** The shape of a reference the JavaScript adapter finds at this position in JSX. */
  readonly jsx: ShapeId;
}

/**
 * Every position both adapters read. JSX keeps one rule of its own beside these: `src`,
 * `srcSet` and `poster` on any element, because a component hands them on to an `<img>`.
 *
 * `<use>` is left out on purpose. Its commonest form, `<use href="#icon">`, names an element
 * in the same document, not a file. `<use href="/sprite.svg#icon">` does name a file, but a
 * vector that Upfly neither converts nor deletes, so linking it gains nothing, while every
 * fragment-only `<use>` would first need filtering out.
 */
export const URL_POSITIONS: readonly UrlPosition[] = [
  { tag: 'img', attribute: 'src', html: 'html.img.src', jsx: 'js.jsx.attribute' },
  { tag: 'img', attribute: 'srcset', html: 'srcset', jsx: 'js.jsx.srcset' },
  { tag: 'source', attribute: 'src', html: 'html.source.src', jsx: 'js.jsx.attribute' },
  { tag: 'source', attribute: 'srcset', html: 'srcset', jsx: 'js.jsx.srcset' },
  { tag: 'video', attribute: 'src', html: 'html.video.src', jsx: 'js.jsx.attribute' },
  { tag: 'video', attribute: 'poster', html: 'html.video.poster', jsx: 'js.jsx.attribute' },
  { tag: 'audio', attribute: 'src', html: 'html.audio.src', jsx: 'js.jsx.attribute' },
  { tag: 'embed', attribute: 'src', html: 'html.embed.src', jsx: 'js.jsx.attribute' },
  { tag: 'input', attribute: 'src', html: 'html.input.src', jsx: 'js.jsx.attribute' },
  { tag: 'object', attribute: 'data', html: 'html.object.data', jsx: 'js.jsx.attribute' },
  { tag: 'track', attribute: 'src', html: 'html.track.src', jsx: 'js.jsx.attribute' },
  { tag: 'link', attribute: 'href', html: linkImageClaim, jsx: 'js.jsx.attribute' },

  // Inline SVG. An `<svg>` inside a page or a component is not an `.svg` file, so no SVG
  // reader would cover these elements. Both spellings count: `href` is the SVG 2 form, and
  // `xlink:href` the SVG 1.1 form that most shipped markup still uses.
  { tag: 'image', attribute: 'href', html: 'html.svg.image.href', jsx: 'js.jsx.svg' },
  { tag: 'image', attribute: 'xlink:href', html: 'html.svg.image.xlink', jsx: 'js.jsx.svg' },
  // Both `feImage` spellings share one shape, where `<image>` has one each: the coverage
  // tree holds too few `feImage` entries to fill two rows.
  { tag: 'feimage', attribute: 'href', html: 'html.svg.feimage', jsx: 'js.jsx.svg' },
  { tag: 'feimage', attribute: 'xlink:href', html: 'html.svg.feimage', jsx: 'js.jsx.svg' },
];

/** The rows by tag, then attribute: every attribute of every element is looked up here. */
const BY_TAG: ReadonlyMap<string, ReadonlyMap<string, UrlPosition>> = (() => {
  const byTag = new Map<string, Map<string, UrlPosition>>();
  for (const position of URL_POSITIONS) {
    const attributes = byTag.get(position.tag) ?? new Map<string, UrlPosition>();
    attributes.set(position.attribute, position);
    byTag.set(position.tag, attributes);
  }
  return byTag;
})();

/**
 * Where an attribute holds a URL, with its claim settled: the shape each adapter gives the
 * reference, or `null` when the attribute holds none on this element.
 *
 * @param tag the tag name, lowercase
 * @param attribute the attribute name, lowercase, a namespace written as in markup
 * @param element the rest of the element, read only by a claim
 */
export function urlPosition(
  tag: string,
  attribute: string,
  element: ClaimedElement,
): { readonly html: ShapeId | 'srcset'; readonly jsx: ShapeId } | null {
  const position = BY_TAG.get(tag)?.get(attribute);
  if (position === undefined) return null;
  if (typeof position.html !== 'function') return { html: position.html, jsx: position.jsx };
  const claimed = position.html(element);
  return claimed === null ? null : { html: claimed, jsx: position.jsx };
}

/**
 * How a `<link>` claims to point at an image, or `null` if it does not.
 *
 * Covers every icon spelling (`icon`, `shortcut icon`, `apple-touch-icon`, `mask-icon`) and
 * `rel="preload" as="image"`, which is how modern pages preload a hero image and is as much
 * a reference as an `<img>`. A `<link>` with neither claim, such as a stylesheet or a web
 * manifest, names a real file Upfly does not index (`html.link.href.other`), so it yields no
 * reference.
 */
function linkImageClaim(element: ClaimedElement): ShapeId | null {
  const relation = element.attribute('rel');
  if (relation === undefined) return null;

  const tokens = relation.toLowerCase().split(/\s+/);
  if (tokens.some((token) => token.includes('icon'))) return 'html.link.href.icon';
  if (tokens.includes('preload') && element.attribute('as')?.toLowerCase() === 'image') {
    return 'html.link.href.preload';
  }
  return null;
}
