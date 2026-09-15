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
import type { ShapeId } from '../shapes.js';
import type { Adapter, RawReference } from '../types.js';
import { findCssReferences } from './css.js';
import { defineAdapter } from './define.js';
import {
  isExternalUrl,
  parseSrcset,
  provablyNotAFile,
  spellingsOf,
  splitPathSuffix,
  templateExpressionReason,
} from './reference-path.js';

type ParsedNode = DefaultTreeAdapterMap['node'];
type ParsedElement = DefaultTreeAdapterMap['element'];

/**
 * Attributes holding exactly one URL, by tag name, each with the SHAPE it produces.
 *
 * ⚠️ The shape lives here rather than in a second table keyed the same way. A parallel
 * list is 6a-decies in miniature: two structures encoding one fact, drifting the first
 * time somebody adds a tag to only one of them.
 */
function attrs(...pairs: readonly (readonly [string, ShapeId])[]): ReadonlyMap<string, ShapeId> {
  return new Map(pairs);
}

const SINGLE_URL_ATTRIBUTES: ReadonlyMap<string, ReadonlyMap<string, ShapeId>> = new Map([
  ['img', attrs(['src', 'html.img.src'])],
  ['source', attrs(['src', 'html.source.src'])],
  ['video', attrs(['src', 'html.video.src'], ['poster', 'html.video.poster'])],
  ['audio', attrs(['src', 'html.audio.src'])],
  ['embed', attrs(['src', 'html.embed.src'])],
  ['input', attrs(['src', 'html.input.src'])],
  ['object', attrs(['data', 'html.object.data'])],
  ['track', attrs(['src', 'html.track.src'])],

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
  ['image', attrs(['href', 'html.svg.image.href'], ['xlink:href', 'html.svg.image.xlink'])],

  // ⚠️ Both spellings land on ONE `feImage` row while `<image>` has two. That is not an
  // oversight: the tree distinguishes `image@href` from `image@xlink:href` because the
  // SVG 1.1 and SVG 2 forms are what shipped markup actually splits over, and it has
  // instances of each. `feImage` has three instances total, so splitting it would make
  // two rows of one or two — §4k wants three to five, and a row that cannot say
  // "4 of 5" is not worth the split. Revisit if reality supplies more.
  ['feimage', attrs(['href', 'html.svg.feimage'], ['xlink:href', 'html.svg.feimage'])],
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

/**
 * Which srcset row a candidate belongs to.
 *
 * `<source srcset>` is one row whatever its descriptors: the whole attribute is the
 * content there, and it fails as a unit. `<img srcset>` splits three ways because the
 * three fail separately — a `w` list is meaningless without the `sizes` attribute
 * beside it, an `x` list ignores `sizes` entirely, and a lone candidate with a
 * descriptor is the case that parses differently from both.
 */
function srcsetShape(tagName: string, descriptor: string, candidateCount: number): ShapeId {
  if (tagName === 'source') return 'html.source.srcset';
  if (candidateCount === 1 && descriptor !== '') return 'html.img.srcset.single';
  return descriptor.endsWith('w') ? 'html.img.srcset.w' : 'html.img.srcset.x';
}

/**
 * Whether the path carries percent-encoding, which is its own row.
 *
 * ⚠️ Disposition beats construct here, the same way `path.absolute-url` does: what
 * would take these out is the decoder, not the attribute they sit in, and R26's spaced
 * filenames are exactly what arrives percent-encoded.
 */
function isPercentEncoded(raw: string): boolean {
  return /%[0-9A-Fa-f]{2}/.test(raw);
}

export const htmlAdapter: Adapter = defineAdapter({
  id: 'html',
  extensions: ['.html', '.htm'],

  findReferences({ file, text }): RawReference[] {
    // parse5 follows the HTML spec's recovery rules, so there is no such thing as
    // an unparseable document and no error branch to handle here.
    //
    // 🔴 `scriptingEnabled: false` — R98, AND IT IS A ONE-WORD OPTION THAT WAS SILENTLY
    // LOSING REFERENCES. parse5 defaults it to TRUE, and with scripting enabled the HTML
    // spec says a `<noscript>` element's contents are RAW TEXT: the parser hands back one
    // text node and the `<img>` inside it never becomes an element. Measured before the
    // change — `<noscript><img src="/a.png"></noscript>` yielded **nothing**, while the
    // identical tag one line outside yielded a reference.
    //
    // ⚠️ **`<noscript><img>` is the standard lazy-loading fallback**, so those references
    // were invisible in exactly the documents that have the most of them — and invisible
    // in the expensive direction: `optimize --replace` rewrites what it can see, converts
    // the asset, and leaves the fallback pointing at a file that is gone. The render it
    // breaks is the one with no JavaScript to recover.
    //
    // **False is the correct setting for a tool that rewrites files**, not a trick: we are
    // not a browser with a script engine, and every byte in the document is a byte we may
    // have to edit. A browser with scripting off — and any user who has it off — sees this
    // markup, which is the whole reason an author writes a `<noscript>` fallback at all.
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

    // 🔴 **THE CHARACTER-REFERENCE TEST USED TO BE HERE AND IT WAS ONE SCOPE TOO EARLY
    // (R99).** parse5 decodes entities, so `src="a&amp;b.png"` is 11 characters of source
    // and 7 of value; we cannot point at the path inside it and a rewrite on a mismatched
    // range would corrupt the file. All of that is right. What was wrong is that it fired
    // on **every attribute of every element** — before anything had decided whether the
    // attribute was a reference position at all. Measured across the five validation
    // repositories: **536 references carried that reason and 535 were phantoms** — other
    // people's `href` URLs, `alt` prose, a PKCS7 certificate blob in a `<meta content>`.
    //
    // ⚠️ **Note the SHAPE of that bug, because it is the inverse of the one rule 9 guards.**
    // Rule 9 exists to stop us silently DROPPING a reference. This silently INVENTED
    // them, and every invention landed in `unsafe`, where it was counted as something we
    // could not handle. **A tool that manufactures its own failures measures itself as
    // worse than it is** — and that is why nobody looked for a year: the number moved in
    // the direction that reads as humility, and a number moving that way does not get
    // audited.
    //
    // So the flag travels and the decision happens inside, at each position that has
    // already been judged a reference.
    const entityEscaped = raw !== attribute.value;

    collectFromAttribute({
      element,
      tagName,
      name: sourceName,
      raw,
      start: range.start,
      end: range.end,
      entityEscaped,
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
  context: Context;
}): void {
  const { element, tagName, name, raw, start, end, entityEscaped, context } = input;

  // R99: every branch below is a reference position, and every one of them must answer
  // the character-reference question the same way. One helper rather than four copies —
  // a fifth reference position added later gets the answer by construction.
  //
  // 🔴 **AND THE HELPER DROPS SOMEBODY ELSE'S URL FIRST, WHICH IS R99'S SECOND HALF AND
  // THE LARGER ONE.** Moving the test inward removed 135 of the 536 phantoms and left
  // **402**, every one of them an absolute URL sitting in a real reference position —
  // `<img src="http://graph.facebook.com/…?type=square&amp;width=100">` and its kind. The
  // guard bypassed not only the position question but `isExternalUrl`, which every
  // unescaped attribute passes through. **An entity in the query string does not make
  // another host's file ours**, so the answer must not depend on the spelling:
  // `src="https://x/a.png"` emits nothing and `src="https://x/a&amp;b.png"` must emit
  // nothing too.
  //
  // ⚠️ **That is a move on evidence ABOUT THE REFERENCE — it is on another host — and not
  // a judgement about what we can handle, which is the only kind of move R109's guard 2
  // allows.** Until a project states its own origin, an absolute URL is not ours (R113).
  const escaped = (isSrcset = false): void => {
    if (escapedIsSomebodyElses(raw, isSrcset)) return;
    // ⚠️ A `srcset` is a LIST, so one range cannot be one path and there is nothing to
    // decode into a lookup. It keeps the old unsafe report; only single-URL attributes
    // are promoted.
    if (isSrcset) {
      addEntityEscapedReference({ start, end }, context);
      return;
    }
    addCharacterReferenceReference(raw, { start, end }, context);
  };

  if (name === 'style') {
    if (entityEscaped) {
      // 🔴 **NOT `escaped()` — the external-URL test must NOT run on a style attribute,
      // and the test suite caught this one line after it was written.** A style
      // attribute holds CSS, and `URL_SCHEME` is *letters then a colon*, so
      // `width: 100%; font: 12px &quot;Inter&quot;` reads as a scheme and the whole
      // attribute vanished. **A silent skip introduced by the fix for a silent invention**
      // — and the nastiest part is that it depended on whitespace: the two real cases in
      // the corpus happen to start with a space, so the measurement still showed them
      // surviving while the ordinary spelling was being dropped.
      addEntityEscapedReference({ start, end }, context);
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
    // R83: two independent branches, so two shapes. What the predicate refuses is a
    // third — `html.link.href.other` — and nothing is emitted for it, which is what
    // makes that row read as a zero-is-correct one.
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
 * Covers every icon spelling — `icon`, `shortcut icon`, `apple-touch-icon`,
 * `mask-icon` — and `rel="preload" as="image"`, which is how modern pages
 * preload a hero image and is just as much a reference as an `<img>`.
 *
 * ⚠️ **It returns WHICH claim rather than a boolean (R83).** These are two independent
 * branches: delete the icon one and preload still works, delete the preload one and
 * icon still works. So they fail separately and belong in separate rows — a boolean
 * would have collapsed them into one and hidden a break in either behind the other.
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

/**
 * Turn a CSS parse failure inside `<style>` into something about the USER'S document.
 *
 * 🔴 **`invalid css syntax at line 1, column 2` is a symptom reported as a diagnosis, and
 * it is useless to the person who has to fix it (R90).** Column 2 of what? The `<style>`
 * body — which, when the tag was never closed, is the whole rest of their file. The
 * sentence a user can act on names the tag, the line, and the thing they can verify for
 * themselves: **their browser does the same.**
 *
 * ⚠️ **The unclosed case is NOT an engine defect, and saying so is the point of the
 * message.** In an HTML file there is no prose: every character is markup, `<style>` opens
 * a raw-text element, and everything to the end of the document is its content. The engine
 * agrees with the browser. Masking it — which `markdown.ts` correctly does, because
 * CommonMark says a raw-text block must *begin a line*, so mid-sentence it is inline HTML
 * — would make us disagree with the browser about what the page renders.
 *
 * ✅ **And it carries the partials (R20).** `UpflyError.partial` exists for exactly this
 * case and its own documentation describes it — *"the HTML adapter, which hands a `<style>`
 * block to the CSS adapter"* — but **only `markdown.ts` ever populated it.** For a plain
 * `.html` file every reference found before the failing `<style>` was discarded: measured
 * at **ten** in the coverage tree's `entity.html`, all of them ordinary `<img src>` tags
 * above the unclosed tag that a browser renders perfectly. The throw still happens and
 * `scan` still records the file as `parse-failed`, so rule 9 is untouched; what changes is
 * that correct references survive, and losing them is what makes an asset look dead.
 */
/**
 * The sentence itself, extracted so the message is one template rather than a chain of
 * concatenations (the `useTemplate` rule, answered the way R81 answered it rather than
 * suppressed — and it reads better as prose sitting on its own).
 */
const UNCLOSED_RAWTEXT =
  'is never closed, so everything after it is inside the stylesheet rather than being markup. A ' +
  'browser reads this document the same way and renders nothing below that point. Close the tag, ' +
  'or write &lt;style&gt; if the word was meant as text.';

function styleElementFailure(element: ParsedElement, context: Context, error: unknown): UpflyError {
  const partial = [...context.references];
  if (!(error instanceof UpflyError)) {
    throw error;
  }

  const location = element.sourceCodeLocation;
  // parse5 leaves `endTag` absent when the tag was never closed, which is the whole tell.
  //
  // ⚠️ BOTH `null` AND `undefined`, and testing only for `null` cost a round trip: the
  // probe that established this printed `JSON.stringify(loc.endTag ?? null)`, which
  // coerces `undefined` to `null` and so could not tell the two apart. The instrument
  // that reads a value must not normalise the thing it is being used to decide.
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
    // A malformed inline style should not take down a whole document, but it must
    // not vanish either: report it as unsafe so the run has a record of it.
    //
    // 🔴 **AND THE REPORT MUST BE ABLE TO TELL THE TWO KINDS APART, BECAUSE THEY ARE
    // OPPOSITE OUTCOMES (R118).** Measured across the five validation repositories, 33
    // style attributes fail to parse and **not one of them contains a `url()`** — they are
    // `style="float:right; margin 0 0 0 15px"`, an author's missing colon, and two Astro
    // `style={{…}}` expressions that are not CSS at all. There is no reference in them to
    // find, so refusing them is a **correct refusal**: R109's box C, a success.
    //
    // A malformed attribute that DOES contain a url-taking function is the other thing
    // entirely — a reference we may be failing to see, R109's box B.
    //
    // ⚠️ **The note says which, rather than the report guessing later.** R111: the engine
    // decides the classification once and publishes it; two consumers deriving it from a
    // parse-error string would derive it differently, and the copies drift (R76).
    const holdsUrlFunction = CSS_URL_FUNCTION.test(css);
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
      }${
        holdsUrlFunction
          ? ' — and it contains a url-taking function, so a reference may be hidden in it'
          : ' — and it contains no url() or image-set(), so there is no reference in it to find'
      }`,
    });
  }
}

/**
 * The two CSS functions that take a file path, for deciding whether an UNPARSEABLE
 * declaration list could be hiding a reference.
 *
 * ⚠️ **Deliberately the same two the CSS adapter actually collects** — `url()` and the
 * `image-set()` family, vendor prefixes included. A quoted string on its own is a
 * reference only inside a preprocessor variable declaration, which a `style` attribute
 * cannot contain. If the CSS adapter ever learns a third position, this test has to learn
 * it too, and that coupling is the reason it is written as one named constant rather than
 * inlined as a string search.
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
 * ⚠️ **A `srcset` is a LIST and must be asked candidate by candidate**, because one
 * external URL beside one local path is not an external attribute. It is asked on the
 * source text rather than on parse5's decoded value for the same reason everything else
 * here is: the decoded value has no offsets into the file.
 *
 * ⚠️ **A `style` attribute never reaches here, and that is load-bearing.** Its text is CSS,
 * and `URL_SCHEME` is *letters then a colon*, so `width: 100%` reads as a scheme and the
 * whole declaration would be dropped. The style branch calls `addEntityEscapedReference`
 * directly for that reason; see the comment there.
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
 * 🔴 **This used to be `unsafe` unconditionally, and that was right only while nothing
 * decoded (R118).** The range covers the ENCODED source text and `rawPath` is that text,
 * so the invariant `source.slice(start, end) === rawPath` holds exactly as before — what
 * changes is that the resolver now also tries the decoded spelling, and `relocate`
 * re-encodes when it writes. `/gallery/a&amp;b.png` names `a&b.png` and is rewritable.
 *
 * 🔴 **BUT ONLY WHEN THE WHOLE PATH DECODES, AND THIS IS THE SAFETY ARGUMENT.** Promoting
 * the ceiling means a lookup, and a lookup that misses does not shrug — it falls through
 * to **`broken`**. So a path containing a character reference outside the bound in
 * `spellingsOf` stays `unsafe`: it goes on being reported as *"we could not read this"*,
 * exactly as it did yesterday. **Declining costs a row in the matrix; a false `broken`
 * costs the promise the product is sold on.**
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
    // 🔴 A DISPOSITION, NOT A HOST SHAPE (R88(a)): what takes this reference out is the
    // spelling of the path, so it beats whatever attribute the path sits in — the same
    // way an absolute URL does.
    //
    // ⚠️ **The precedence used to be structural and that was R99's bug.** This fired
    // before any host shape was chosen, which also meant before anything asked whether
    // the attribute was a reference position — so `path.charref` beat not only the host
    // shape but the question *is this a reference at all*. It is now reached from inside
    // each reference position, so the disposition still wins over the construct and no
    // longer wins over the position.
    shape: 'path.charref',
    ceiling: 'unsafe',
    asserted: true,
    note: 'contains HTML character references, so the path text cannot be located exactly',
  });
}

function addAttributeReference(raw: string, start: number, context: Context, shape: ShapeId): void {
  if (raw === '') return;
  if (isExternalUrl(raw, 'attr')) return;
  // R108. Beside the external-URL test because it answers the same kind of question —
  // *is there a file of ours at the end of this at all* — and before the template branch
  // because that branch is where a path with no testable extension ends up.
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
    // Disposition beats the attribute it sits in: what would take a percent-encoded
    // path out is the decoder, not `<img src>`.
    shape: isPercentEncoded(path) ? 'html.percent-encoded' : shape,
    ceiling: 'high',
    asserted: true,
    ...(suffix === '' ? {} : { note: `query or fragment preserved: ${suffix}` }),
  });
}
