/**
 * The HTML adapter.
 *
 * Finds image references in attributes (`src`, `srcset`, `poster`, icon `href`) and
 * in the CSS that HTML carries around with it — `<style>` elements and `style=""`
 * attributes, both handed to the CSS adapter's scanner so there is one
 * implementation of CSS semantics rather than a weaker second one here.
 *
 * parse5 does the parsing, and it earns its place immediately: an `<img>` inside an
 * HTML comment is a comment node, never an element, so commented-out markup cannot
 * be mistaken for live markup. It also reports the exact source range of every
 * attribute, which is what makes a safe rewrite possible.
 */

import { type DefaultTreeAdapterMap, parse } from 'parse5';
import { UpflyError } from '../errors.js';
import type { Adapter, RawReference } from '../types.js';
import { findCssReferences } from './css.js';
import { defineAdapter } from './define.js';
import {
  isExternalUrl,
  parseSrcset,
  splitPathSuffix,
  templateExpressionReason,
} from './reference-path.js';

type ParsedNode = DefaultTreeAdapterMap['node'];
type ParsedElement = DefaultTreeAdapterMap['element'];

/** Attributes holding exactly one URL, by tag name. */
const SINGLE_URL_ATTRIBUTES: ReadonlyMap<string, readonly string[]> = new Map([
  ['img', ['src']],
  ['source', ['src']],
  ['video', ['src', 'poster']],
  ['audio', ['src']],
  ['embed', ['src']],
  ['input', ['src']],
  ['object', ['data']],
  ['track', ['src']],

  // ⚠️ **Inline SVG (R26), and this was missed because of where it was written down.**
  // ARCHITECTURE.md recorded `<image href>` as a known gap *"for `.svg` files"* — true,
  // and it hid the bigger case: an inline `<svg>` inside an HTML document or a JSX
  // component is **not** an `.svg` file, so no future SVG adapter would ever have
  // covered it. It is this adapter's element and it was simply absent from this map.
  //
  // Tag names arrive lowercased (`element.tagName.toLowerCase()`), which is why the key
  // is `feimage` — the HTML parser's foreign-content adjustment spells the element
  // `feImage` and a capitalised key here would never match.
  //
  // Both attribute spellings: `href` is the SVG 2 form, `xlink:href` the SVG 1.1 form
  // that is still overwhelmingly what shipped markup contains.
  ['image', ['href', 'xlink:href']],
  ['feimage', ['href', 'xlink:href']],
]);

// ⚠️ `<use>` is deliberately absent from the map above, and this is the reason rather
// than an oversight. `<use href="#icon">` is a same-document reference to an element id —
// the commonest form by far, and not a file at all. `<use href="/sprite.svg#icon">` *is*
// a file reference, but its target is a vector we neither convert nor delete, so linking
// it buys nothing today while every fragment-only `use` in the wild would need filtering
// first. Measured incidence of `<use href>` naming an image across the three validation
// repos: **0**. Written down so adding it later is a decision, not a rediscovery.

/** Attributes holding a comma-separated candidate list, by tag name. */
const SRCSET_ATTRIBUTES: ReadonlyMap<string, readonly string[]> = new Map([
  ['img', ['srcset']],
  ['source', ['srcset']],
]);

export const htmlAdapter: Adapter = defineAdapter({
  id: 'html',
  extensions: ['.html', '.htm'],

  findReferences({ file, text }): RawReference[] {
    // parse5 follows the HTML spec's recovery rules, so there is no such thing as
    // an unparseable document and no error branch to handle here.
    const document = parse(text, { sourceCodeLocationInfo: true });

    const references: RawReference[] = [];
    walk(document, { file, text, references });
    return references.sort((a, b) => a.start - b.start);
  },
});

interface Context {
  readonly file: string;
  readonly text: string;
  readonly references: RawReference[];
}

function walk(node: ParsedNode, context: Context): void {
  if (isElement(node)) {
    collectFromElement(node, context);
  }
  if ('childNodes' in node) {
    for (const child of node.childNodes) {
      walk(child, context);
    }
  }
}

function isElement(node: ParsedNode): node is ParsedElement {
  return 'tagName' in node && 'attrs' in node;
}

function collectFromElement(element: ParsedElement, context: Context): void {
  const tagName = element.tagName.toLowerCase();

  if (tagName === 'style') {
    collectFromStyleElement(element, context);
  }

  // Elements the parser inferred rather than read (an implied <body>, say) have no
  // location, and therefore no attributes we could point at.
  const attributeLocations = element.sourceCodeLocation?.attrs;
  if (attributeLocations === undefined) return;

  for (const attribute of element.attrs) {
    // ⚠️ **The location map is keyed by the SOURCE spelling, and parse5 splits a
    // namespaced attribute.** `xlink:href` arrives as `{ name: 'href', prefix: 'xlink' }`
    // while its location sits under `'xlink:href'`, so looking up the bare name found
    // nothing and the attribute was skipped — silently, which is the rule 9 shape. It
    // cost R26's `<image xlink:href>` case even after the element was added to the map.
    const name = attribute.name.toLowerCase();
    const sourceName =
      attribute.prefix === undefined ? name : `${attribute.prefix.toLowerCase()}:${name}`;
    const location = attributeLocations[sourceName];
    if (location === undefined) continue;

    const range = attributeValueRange(context.text, location.startOffset, location.endOffset);
    if (range === null) continue; // A valueless attribute such as `hidden`.

    const raw = context.text.slice(range.start, range.end);
    if (raw !== attribute.value) {
      // parse5 decodes entities, so `src="a&amp;b.png"` is 11 characters of source
      // and 7 of value. We cannot point at the path inside it, and a rewrite based
      // on a mismatched range would corrupt the file — so say so and move on.
      addEntityEscapedReference(range, context);
      continue;
    }

    collectFromAttribute({ element, tagName, name: sourceName, raw, start: range.start, context });
  }
}

/** Decide what one attribute is, now that its value has been located in the source. */
function collectFromAttribute(input: {
  element: ParsedElement;
  tagName: string;
  name: string;
  raw: string;
  start: number;
  context: Context;
}): void {
  const { element, tagName, name, raw, start, context } = input;

  if (name === 'style') {
    collectFromStyleAttribute(raw, start, context);
    return;
  }

  if ((SRCSET_ATTRIBUTES.get(tagName) ?? []).includes(name)) {
    for (const candidate of parseSrcset(raw)) {
      addAttributeReference(candidate.url, start + candidate.offset, context);
    }
    return;
  }

  if ((SINGLE_URL_ATTRIBUTES.get(tagName) ?? []).includes(name)) {
    addAttributeReference(raw, start, context);
    return;
  }

  if (tagName === 'link' && name === 'href' && linkPointsAtAnImage(element)) {
    addAttributeReference(raw, start, context);
  }
}

/**
 * Whether a `<link>` points at an image.
 *
 * Covers every icon spelling — `icon`, `shortcut icon`, `apple-touch-icon`,
 * `mask-icon` — and `rel="preload" as="image"`, which is how modern pages
 * preload a hero image and is just as much a reference as an `<img>`.
 */
function linkPointsAtAnImage(element: ParsedElement): boolean {
  const relation = attributeValue(element, 'rel');
  if (relation === undefined) return false;

  const tokens = relation.toLowerCase().split(/\s+/);
  if (tokens.some((token) => token.includes('icon'))) return true;
  return tokens.includes('preload') && attributeValue(element, 'as')?.toLowerCase() === 'image';
}

function attributeValue(element: ParsedElement, name: string): string | undefined {
  return element.attrs.find((attribute) => attribute.name.toLowerCase() === name)?.value;
}

function collectFromStyleElement(element: ParsedElement, context: Context): void {
  for (const child of element.childNodes) {
    if (child.nodeName !== '#text') continue;
    const location = child.sourceCodeLocation;
    if (location === undefined || location === null) continue;

    const css = context.text.slice(location.startOffset, location.endOffset);

    // ⚠️ A `<style>` block whose body is a **template** is not CSS yet (R25 #5).
    // `eleventy-docs/src/docs/data-js.md:133` holds `<style>` followed by
    // `{% if myProject.environment == "production" %}`, and PostCSS dies on the `%`
    // — taking the whole document's references with it. R20 masks *unclosed*
    // raw-text tags and deliberately leaves closed ones scanned, so this is the gap
    // that fix left, and it is not exotic: Eleventy, Jekyll, Hugo, Nunjucks and
    // Liquid all inline conditional CSS exactly this way.
    //
    // The detector already exists and is already what the report prints elsewhere
    // for a templated path, so this reuses it rather than inventing a second
    // opinion about what a template looks like.
    const templated = templateExpressionReason(css);
    if (templated !== null) {
      context.references.push({
        file: context.file,
        start: location.startOffset,
        end: location.endOffset,
        rawPath: css,
        kind: 'css-url',
        ceiling: 'unsafe',
        asserted: false,
        note: `a <style> block built by a template, so its CSS is not final: ${templated}`,
      });
      continue;
    }

    context.references.push(
      ...findCssReferences({
        file: context.file,
        text: css,
        baseOffset: location.startOffset,
      }),
    );
  }
}

function collectFromStyleAttribute(css: string, baseOffset: number, context: Context): void {
  try {
    context.references.push(...findCssReferences({ file: context.file, text: css, baseOffset }));
  } catch (error) {
    // A malformed inline style should not take down a whole document, but it must
    // not vanish either: report it as unsafe so the run has a record of it.
    context.references.push({
      file: context.file,
      start: baseOffset,
      end: baseOffset + css.length,
      rawPath: css,
      kind: 'css-url',
      ceiling: 'unsafe',
      asserted: false,
      note: `could not parse the style attribute: ${
        error instanceof UpflyError ? error.message : String(error)
      }`,
    });
  }
}

/**
 * Locate the value inside an attribute's source range.
 *
 * parse5 gives the range of the whole `name="value"`, so the quotes have to be
 * stepped over here. Unquoted values (`src=hero.png`) run to the end of the range.
 */
function attributeValueRange(
  text: string,
  startOffset: number,
  endOffset: number,
): { start: number; end: number } | null {
  const attribute = text.slice(startOffset, endOffset);
  const equals = attribute.indexOf('=');
  if (equals === -1) return null;

  let index = equals + 1;
  while (index < attribute.length && /\s/.test(attribute.charAt(index))) index += 1;

  const quote = attribute.charAt(index);
  if (quote === '"' || quote === "'") {
    return { start: startOffset + index + 1, end: startOffset + attribute.length - 1 };
  }
  return { start: startOffset + index, end: endOffset };
}

function addEntityEscapedReference(range: { start: number; end: number }, context: Context): void {
  context.references.push({
    file: context.file,
    start: range.start,
    end: range.end,
    rawPath: context.text.slice(range.start, range.end),
    kind: 'attr',
    ceiling: 'unsafe',
    asserted: true,
    note: 'contains HTML character references, so the path text cannot be located exactly',
  });
}

function addAttributeReference(raw: string, start: number, context: Context): void {
  if (raw === '') return;
  if (isExternalUrl(raw, 'attr')) return;

  const reason = templateExpressionReason(raw);
  if (reason !== null) {
    context.references.push({
      file: context.file,
      start,
      end: start + raw.length,
      rawPath: raw,
      kind: 'attr',
      ceiling: 'unsafe',
      asserted: true,
      note: reason,
    });
    return;
  }

  const { path, suffix } = splitPathSuffix(raw);
  if (path === '') return;

  context.references.push({
    file: context.file,
    start,
    // The range covers the path alone, so a rewrite preserves the author's `?v=2`.
    end: start + path.length,
    rawPath: path,
    kind: 'attr',
    ceiling: 'high',
    asserted: true,
    ...(suffix === '' ? {} : { note: `query or fragment preserved: ${suffix}` }),
  });
}
