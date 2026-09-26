/**
 * The HTML adapter.
 *
 * Finds image references in attributes (`src`, `srcset`, `poster`, icon `href`) and in
 * the CSS that HTML carries: `<style>` elements and `style=""` attributes, both handed to
 * the CSS adapter's scanner. See "The six that exist" in ARCHITECTURE.md.
 *
 * parse5 parses by the HTML specification, so an `<img>` inside a comment is a comment
 * node, never an element, and every attribute comes with its exact source range, which is
 * what makes a safe rewrite possible.
 */

import { type DefaultTreeAdapterMap, parse } from 'parse5';
import { UpflyError } from '../errors.js';
import type { ShapeId } from '../shapes.js';
import type { Adapter, RawReference } from '../types.js';
import { findCssReferences } from './css.js';
import { defineAdapter } from './define.js';
import {
  decodeCharacterReferencesWithMap,
  isExternalUrl,
  parseSrcset,
  provablyNotAFile,
  spellingsOf,
  splitPathSuffix,
  templateExpressionReason,
} from './reference-path.js';

type ParsedNode = DefaultTreeAdapterMap['node'];
type ParsedElement = DefaultTreeAdapterMap['element'];

function attrs(...pairs: readonly (readonly [string, ShapeId])[]): ReadonlyMap<string, ShapeId> {
  return new Map(pairs);
}

/**
 * Attributes holding exactly one URL, by tag name, each with the shape it produces.
 *
 * The shape lives in this map rather than in a second table keyed the same way, so a tag
 * cannot be added to one and forgotten in the other.
 */
const SINGLE_URL_ATTRIBUTES: ReadonlyMap<string, ReadonlyMap<string, ShapeId>> = new Map([
  ['img', attrs(['src', 'html.img.src'])],
  ['source', attrs(['src', 'html.source.src'])],
  ['video', attrs(['src', 'html.video.src'], ['poster', 'html.video.poster'])],
  ['audio', attrs(['src', 'html.audio.src'])],
  ['embed', attrs(['src', 'html.embed.src'])],
  ['input', attrs(['src', 'html.input.src'])],
  ['object', attrs(['data', 'html.object.data'])],
  ['track', attrs(['src', 'html.track.src'])],

  // Inline SVG. An `<svg>` inside an HTML document is not an `.svg` file, so no SVG adapter
  // would cover these elements. Both attribute spellings count: `href` is the SVG 2 form,
  // and `xlink:href` the SVG 1.1 form that most shipped markup still uses.
  //
  // Keys are lowercase because `collectFromElement` lowercases tag names. The HTML parser
  // spells the element `feImage` (the specification's table for adjusting SVG tag names),
  // so a key written that way would never match.
  ['image', attrs(['href', 'html.svg.image.href'], ['xlink:href', 'html.svg.image.xlink'])],

  // Both `feImage` spellings share one shape, where `<image>` has one each: the coverage
  // tree holds too few `feImage` entries to fill two rows.
  ['feimage', attrs(['href', 'html.svg.feimage'], ['xlink:href', 'html.svg.feimage'])],
]);

// `<use>` is left out on purpose. Its commonest form, `<use href="#icon">`, names an element
// in the same document, not a file. `<use href="/sprite.svg#icon">` does name a file, but a
// vector that Upfly neither converts nor deletes, so linking it gains nothing, while every
// fragment-only `<use>` would first need filtering out.

/** Attributes holding a comma-separated candidate list, by tag name. */
const SRCSET_ATTRIBUTES: ReadonlyMap<string, readonly string[]> = new Map([
  ['img', ['srcset']],
  ['source', ['srcset']],
]);

/**
 * Which srcset row a candidate belongs to.
 *
 * `<source srcset>` is one row whatever its descriptors: the whole attribute is the
 * content there, and it fails as a unit. `<img srcset>` splits three ways because the
 * three fail separately: a `w` list is meaningless without the `sizes` attribute
 * beside it, an `x` list ignores `sizes` entirely, and a lone candidate with a
 * descriptor is the case that parses differently from both.
 */
function srcsetShape(tagName: string, descriptor: string, candidateCount: number): ShapeId {
  if (tagName === 'source') return 'html.source.srcset';
  if (candidateCount === 1 && descriptor !== '') return 'html.img.srcset.single';
  return descriptor.endsWith('w') ? 'html.img.srcset.w' : 'html.img.srcset.x';
}

/** Whether the path carries percent-encoding. */
function isPercentEncoded(raw: string): boolean {
  return /%[0-9A-Fa-f]{2}/.test(raw);
}

export const htmlAdapter: Adapter = defineAdapter({
  id: 'html',
  extensions: ['.html', '.htm'],

  findReferences({ file, text }): RawReference[] {
    // parse5 follows the HTML spec's error recovery, so there is no such thing as an
    // unparseable document and no error branch here.
    //
    // `scriptingEnabled: false`, where parse5 defaults to true. With the scripting flag set,
    // the HTML spec parses `<noscript>` content as raw text, so an `<img>` inside it never
    // becomes an element. `<noscript><img>` is the standard lazy-loading fallback: missed, it
    // would be left pointing at an original that `optimize --replace` removed, breaking the
    // one render that has no script to recover.
    const document = parse(text, { sourceCodeLocationInfo: true, scriptingEnabled: false });

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
    // The location map is keyed by the source spelling, but parse5 splits a namespaced
    // attribute: `xlink:href` arrives as `{ name: 'href', prefix: 'xlink' }` while its
    // location sits under `'xlink:href'`. Looking up the bare name would skip it silently.
    const name = attribute.name.toLowerCase();
    const sourceName =
      attribute.prefix === undefined ? name : `${attribute.prefix.toLowerCase()}:${name}`;
    const location = attributeLocations[sourceName];
    if (location === undefined) continue;

    const range = attributeValueRange(context.text, location.startOffset, location.endOffset);
    if (range === null) continue; // A valueless attribute such as `hidden`.

    const raw = context.text.slice(range.start, range.end);

    // parse5 decodes character references, so `src="a&amp;b.png"` is 11 characters of
    // source and 7 of value, and no range into the source spells the decoded path. Only a
    // reference position may decide what that means, so the flag travels with the
    // attribute: deciding here would report every escaped `alt` or `<meta content>` as a
    // reference the engine could not handle.
    // See "Character references in HTML attributes" in ARCHITECTURE.md.
    const entityEscaped = raw !== attribute.value;

    collectFromAttribute({
      element,
      tagName,
      name: sourceName,
      raw,
      start: range.start,
      end: range.end,
      entityEscaped,
      // parse5's decoded value, carried so a style attribute can be read as the CSS a
      // browser sees, and so our bounded decoder can be checked against a complete one
      // before any offset derived from it is trusted.
      decodedValue: attribute.value,
      context,
    });
  }
}

/** Decide what one attribute is, now that its value has been located in the source. */
function collectFromAttribute(input: {
  element: ParsedElement;
  tagName: string;
  name: string;
  raw: string;
  start: number;
  end: number;
  /** parse5's decoded value differs from the source text, so no range locates the path. */
  entityEscaped: boolean;
  /** That decoded value, for the style branch, the one that can map offsets back. */
  decodedValue: string;
  context: Context;
}): void {
  const { element, tagName, name, raw, start, end, entityEscaped, decodedValue, context } = input;

  // Every URL-valued position below answers the character-reference question through this
  // one helper, so a new position gets the same answer. It drops another host's URL first,
  // as `addAttributeReference` does for an unescaped one: an entity in a query string
  // (`?w=1&amp;h=2`) does not make that file ours.
  const escaped = (isSrcset = false): void => {
    if (escapedIsSomebodyElses(raw, isSrcset)) return;
    // A `srcset` is a list, so its one range is not one path and there is nothing to
    // decode for a lookup. It stays unsafe; only single-URL attributes are resolved decoded.
    if (isSrcset) {
      addEntityEscapedReference({ start, end }, context);
      return;
    }
    addCharacterReferenceReference(raw, { start, end }, context);
  };

  if (name === 'style') {
    if (entityEscaped) {
      // Not `escaped()`: a style attribute holds CSS, and the external-URL test reads
      // `width: 100%` as a URL scheme (letters, then a colon), which would drop the whole
      // attribute. A value that starts with a space slips past that test, so a test of
      // this branch needs one that does not.
      if (collectFromEscapedStyleAttribute(raw, decodedValue, start, context)) return;
      addStyleAttributeRefusal(raw, { start, end }, context);
      return;
    }
    collectFromStyleAttribute(raw, start, context);
    return;
  }

  if ((SRCSET_ATTRIBUTES.get(tagName) ?? []).includes(name)) {
    if (entityEscaped) {
      escaped(true);
      return;
    }
    const candidates = parseSrcset(raw);
    for (const candidate of candidates) {
      addAttributeReference(
        candidate.url,
        start + candidate.offset,
        context,
        srcsetShape(tagName, candidate.descriptor, candidates.length),
      );
    }
    return;
  }

  const single = SINGLE_URL_ATTRIBUTES.get(tagName)?.get(name);
  if (single !== undefined) {
    if (entityEscaped) {
      escaped();
      return;
    }
    addAttributeReference(raw, start, context, single);
    return;
  }

  if (tagName === 'link' && name === 'href') {
    // A `<link>` with neither claim, such as a stylesheet or a web manifest, names a real
    // file Upfly does not index (`html.link.href.other`), so nothing is emitted for it.
    const claim = linkImageClaim(element);
    if (claim === null) return;
    if (entityEscaped) {
      escaped();
      return;
    }
    addAttributeReference(raw, start, context, claim);
  }
}

/**
 * How a `<link>` claims to point at an image, or `null` if it does not.
 *
 * Covers every icon spelling (`icon`, `shortcut icon`, `apple-touch-icon`, `mask-icon`)
 * and `rel="preload" as="image"`, which is how modern pages preload a hero image and is
 * as much a reference as an `<img>`.
 *
 * It returns which claim rather than a boolean because the two branches fail separately:
 * each has its own shape, so a break in one cannot hide behind the other.
 */
function linkImageClaim(element: ParsedElement): ShapeId | null {
  const relation = attributeValue(element, 'rel');
  if (relation === undefined) return null;

  const tokens = relation.toLowerCase().split(/\s+/);
  if (tokens.some((token) => token.includes('icon'))) return 'html.link.href.icon';
  if (tokens.includes('preload') && attributeValue(element, 'as')?.toLowerCase() === 'image') {
    return 'html.link.href.preload';
  }
  return null;
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

    // A `<style>` body built by a template (`{% if production %}`, as Eleventy, Jekyll,
    // Hugo, Nunjucks and Liquid sites inline conditional CSS) is not CSS yet, and PostCSS
    // would fail on it and fail the whole document. It is reported as unsafe instead, found
    // by `templateExpressionReason` as a templated path is.
    const templated = templateExpressionReason(css);
    if (templated !== null) {
      context.references.push({
        file: context.file,
        start: location.startOffset,
        end: location.endOffset,
        rawPath: css,
        kind: 'css-url',
        shape: 'html.style.element',
        ceiling: 'unsafe',
        asserted: false,
        note: `a <style> block built by a template, so its CSS is not final: ${templated}`,
      });
      continue;
    }

    try {
      context.references.push(
        ...findCssReferences({
          file: context.file,
          text: css,
          baseOffset: location.startOffset,
          hostShape: 'html.style.element',
        }),
      );
    } catch (error) {
      throw styleElementFailure(element, context, error);
    }
  }
}

/** The rest of the message for an unclosed `<style>`, after the words naming the tag. */
const UNCLOSED_RAWTEXT =
  'is never closed, so everything after it is inside the stylesheet rather than being markup. A ' +
  'browser reads this document the same way and renders nothing below that point. Close the tag, ' +
  'or write &lt;style&gt; if the word was meant as text.';

/**
 * Turn a CSS parse failure inside `<style>` into an error about the user's document.
 *
 * The parser's position (`line 1, column 2`) is relative to the `<style>` body, which for a
 * tag never closed is the rest of the file, so the message names the tag and its line. An
 * unclosed `<style>` is not an engine defect: in HTML every character is markup, so it
 * opens a raw-text element that runs to the end of the document, as it does in a browser.
 * Masking the tag, as `maskUnclosedRawText` does for Markdown prose, would disagree with
 * the browser about what the page renders.
 *
 * The error carries the references found before the failure as `partial`. `scan` still
 * reports the file as `parse-failed` and keeps them, since losing the correct references
 * above the tag would make their assets look dead.
 */
function styleElementFailure(element: ParsedElement, context: Context, error: unknown): UpflyError {
  const partial = [...context.references];
  if (!(error instanceof UpflyError)) {
    throw error;
  }

  const location = element.sourceCodeLocation;
  // parse5 leaves `endTag` unset when the tag was never closed.
  const unclosed =
    location !== undefined &&
    location !== null &&
    (location.endTag === null || location.endTag === undefined);
  if (!unclosed) {
    return new UpflyError(error.code, error.message, partial, error.diagnostic);
  }

  const line = location?.startTag?.startLine;
  const where = line === undefined ? 'A <style>' : `The <style> on line ${line}`;
  return new UpflyError(
    'ADAPTER_PARSE_FAILED',
    `${where} ${UNCLOSED_RAWTEXT}`,
    partial,
    error.diagnostic,
  );
}

/**
 * An entity-escaped style attribute that `collectFromEscapedStyleAttribute` could not read,
 * reported as unsafe with a note saying whether it could hide a reference.
 */
function addStyleAttributeRefusal(
  css: string,
  range: { start: number; end: number },
  context: Context,
): void {
  context.references.push({
    file: context.file,
    start: range.start,
    end: range.end,
    rawPath: css,
    kind: 'css-url',
    shape: 'html.style.attribute',
    ceiling: 'unsafe',
    asserted: false,
    note: `the style attribute contains HTML character references, so its CSS cannot be handed to the parser with offsets that hold${describeUrlFunction(css)}`,
  });
}

/**
 * The end of a style-attribute refusal's note, shared by the escaped and the unparseable
 * case so the two cannot drift: it says whether the CSS holds a url-taking function.
 * `report.ts` counts the refusal as correct when the note says "no reference in it to
 * find", so that wording is load-bearing.
 */
function describeUrlFunction(css: string): string {
  return CSS_URL_FUNCTION.test(css)
    ? ' — and it contains a url-taking function, so a reference may be hidden in it'
    : ' — and it contains no url() or image-set(), so there is no reference in it to find';
}

/**
 * A style attribute whose CSS is spelled with character references, read properly.
 *
 * In `style="background-image: url(&quot;/logo.png&quot;)"` only the delimiters are encoded
 * and the path is plain in the source, so the CSS is decoded for the parser and each
 * reference is mapped back to source offsets. Three guards must hold, or the caller refuses
 * the whole attribute, so the worst case is a refusal and never a wrong range:
 * 1. Our decoder finishes. It knows numeric references and five named ones; `&nbsp;` stops it.
 * 2. Our decoded text equals parse5's. parse5 knows every named reference in the HTML spec,
 *    so where the two differ our offsets would describe text the browser never saw.
 * 3. Each mapped range starts within the attribute, runs forwards, and is no shorter than
 *    the path the CSS adapter found.
 *
 * @returns `true` when it handled the attribute, `false` to let the caller refuse it.
 */
function collectFromEscapedStyleAttribute(
  raw: string,
  parserValue: string,
  baseOffset: number,
  context: Context,
): boolean {
  const decoded = decodeCharacterReferencesWithMap(raw);
  if (decoded === null) return false;
  // Guard 2: agree with parse5, which knows every named reference.
  if (decoded.text !== parserValue) return false;

  let found: RawReference[];
  try {
    found = findCssReferences({
      file: context.file,
      text: decoded.text,
      hostShape: 'html.style.attribute',
    });
  } catch {
    // A malformed declaration list is the caller's to report, with its url() test.
    return false;
  }

  const remapped: RawReference[] = [];
  for (const reference of found) {
    const start = baseOffset + (decoded.map[reference.start] ?? -1);
    const end = baseOffset + (decoded.map[reference.end] ?? -1);
    if (start < baseOffset || end < start) return false;

    const rawPath = context.text.slice(start, end);
    // Guard 3. `rawPath` is sliced from the source, so it matches its range by
    // construction; the length check catches a map that is wrong but still yields a string.
    if (rawPath.length < reference.rawPath.length) return false;

    remapped.push({ ...reference, start, end, rawPath });
  }

  context.references.push(...remapped);
  return true;
}

function collectFromStyleAttribute(css: string, baseOffset: number, context: Context): void {
  try {
    context.references.push(
      ...findCssReferences({
        file: context.file,
        text: css,
        baseOffset,
        hostShape: 'html.style.attribute',
      }),
    );
  } catch (error) {
    // A malformed inline style must not take down the document, and must not vanish
    // either, so it is reported as unsafe. Its note says whether the CSS holds a
    // url-taking function, because the two cases are opposite outcomes: without one there
    // is nothing to find and the refusal is correct (an author's missing colon, or an
    // Astro `style={{…}}` object); with one, a reference may be hidden. The engine decides
    // this once, here, so no consumer has to derive it from the parser's message.
    context.references.push({
      file: context.file,
      start: baseOffset,
      end: baseOffset + css.length,
      rawPath: css,
      kind: 'css-url',
      shape: 'html.style.attribute',
      ceiling: 'unsafe',
      asserted: false,
      note: `could not parse the style attribute: ${
        error instanceof UpflyError ? error.message : String(error)
      }${describeUrlFunction(css)}`,
    });
  }
}

/**
 * The CSS functions that take a file path, to decide whether an unparseable declaration
 * list could hide a reference.
 *
 * They are the ones the CSS adapter collects: `url()` and `image-set()`, vendor prefixes
 * included. A bare quoted string is a reference only in a preprocessor variable, which a
 * `style` attribute cannot hold. If the CSS adapter learns another position, add it here.
 */
const CSS_URL_FUNCTION = /\b(?:url|(?:-[a-z]+-)?image-set)\s*\(/i;

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

/**
 * Whether an entity-escaped attribute names nothing of ours, so there is no path we are
 * failing to locate.
 *
 * A `srcset` is a list and is asked candidate by candidate, because one external URL
 * beside a local path does not make the attribute external. A `style` attribute must
 * never reach this test; see the style branch of `collectFromAttribute`.
 */
function escapedIsSomebodyElses(raw: string, isSrcset: boolean): boolean {
  if (!isSrcset) return isExternalUrl(raw, 'attr');
  const candidates = parseSrcset(raw);
  return (
    candidates.length > 0 && candidates.every((candidate) => isExternalUrl(candidate.url, 'attr'))
  );
}

/**
 * A URL-valued attribute whose path is spelled with character references.
 *
 * The range covers the encoded source text and `rawPath` is that text, so the range
 * invariant holds; the resolver also tries the decoded spelling, and `relocate` re-encodes
 * when it writes. `/gallery/a&amp;b.png` names `a&b.png` and can be rewritten.
 *
 * That needs the whole path to decode. A `high` ceiling means a lookup, and a lookup that
 * misses reports `broken`, so a path holding a reference outside the decoder's bound stays
 * `unsafe`: declining is only a refusal, while a false `broken` is the one error the
 * engine promises not to make.
 */
function addCharacterReferenceReference(
  raw: string,
  range: { start: number; end: number },
  context: Context,
): void {
  const decodable = spellingsOf(raw).some(({ spelling }) => spelling === 'html-entities');
  if (!decodable) {
    addEntityEscapedReference(range, context);
    return;
  }

  context.references.push({
    file: context.file,
    start: range.start,
    end: range.end,
    rawPath: raw,
    kind: 'attr',
    shape: 'path.charref',
    ceiling: 'high',
    asserted: true,
    note: 'the path is spelled with HTML character references; it is resolved decoded and rewritten re-encoded',
  });
}

function addEntityEscapedReference(range: { start: number; end: number }, context: Context): void {
  context.references.push({
    file: context.file,
    start: range.start,
    end: range.end,
    rawPath: context.text.slice(range.start, range.end),
    kind: 'attr',
    // The shape names the path's spelling rather than the attribute, as for an absolute
    // URL: the spelling is what would break this reference.
    shape: 'path.charref',
    ceiling: 'unsafe',
    asserted: true,
    note: 'contains HTML character references, so the path text cannot be located exactly',
  });
}

function addAttributeReference(raw: string, start: number, context: Context, shape: ShapeId): void {
  if (raw === '') return;
  if (isExternalUrl(raw, 'attr')) return;
  // Like the external-URL test, this asks whether a file of ours could be at the end of the
  // path at all. It runs before the template test, so a templated path that provably names
  // no file (`{{ base }}/`) is dropped rather than reported as dynamic.
  if (provablyNotAFile(raw) !== null) return;

  const reason = templateExpressionReason(raw);
  if (reason !== null) {
    context.references.push({
      file: context.file,
      start,
      end: start + raw.length,
      rawPath: raw,
      kind: 'attr',
      shape,
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
    // The encoding outranks the attribute, as it does for `path.absolute-url`: what would
    // break a percent-encoded path (a filename with spaces, say) is the decoder, not `<img src>`.
    shape: isPercentEncoded(path) ? 'html.percent-encoded' : shape,
    ceiling: 'high',
    asserted: true,
    ...(suffix === '' ? {} : { note: `query or fragment preserved: ${suffix}` }),
  });
}
