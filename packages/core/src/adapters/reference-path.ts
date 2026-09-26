/**
 * Small syntactic judgements about a reference path, shared by every adapter.
 *
 * Nothing here resolves a path or asks whether a file exists: these functions read only
 * the text an author wrote, which is all an adapter may do.
 */

import type { ReferenceKind } from '../types.js';

/**
 * A URL scheme: a letter, then letters, digits, `+`, `-` or `.`, then a colon. A relative
 * path would need a colon before its first slash to match, which nobody writes on purpose.
 */
const URL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Whether a reference points somewhere other than a file in this project: a `data:` URI,
 * a URL with a scheme such as `https:`, a protocol-relative `//cdn/x.png`, or a
 * `#fragment` such as `url(#gradient)`, which names an element in the same document.
 *
 * Adapters drop these without a report line. They were never candidate asset references,
 * and reporting `url(data:image/png;base64,…)` as broken would be wrong.
 *
 * @param kind Required because a leading `#` depends on it. In a module specifier
 * (`'import'`), `#internal/a.png` is a Node subpath import, which the resolver handles as
 * an alias; anywhere else it is a fragment. A default would let a call site keep the wrong
 * reading silently.
 */
export function isExternalUrl(rawPath: string, kind: ReferenceKind): boolean {
  if (rawPath.startsWith('#')) {
    if (kind === 'import') return false;
    // `#{…}` opens a SCSS interpolation: `#{$dir}/hero.png` is a path the preprocessor
    // builds. Kept, it is reported as dynamic; dropped here, it would vanish.
    return !rawPath.startsWith('#{');
  }
  return rawPath.startsWith('//') || URL_SCHEME.test(rawPath);
}

/** The template holes `staticExtensionOf` flattens: `${…}`, `{{…}}`, `{%…%}` and `#{…}`. */
const TEMPLATE_HOLE = /\$\{[^}]*\}|\{\{[^}]*\}\}|\{%[^%]*%\}|#\{[^}]*\}/g;

/**
 * The extension a path shows statically, lowercased, or `''` when it has none or a
 * template hole hides it.
 *
 * `components/ui/${name}.tsx` shows `.tsx`. `/view/${style}/${name}` shows nothing, and
 * neither does `hero.${ext}`, where the hole is the extension.
 */
export function staticExtensionOf(rawPath: string): string {
  const { path } = splitPathSuffix(rawPath);
  const flattened = path.replace(TEMPLATE_HOLE, '*');
  const extension = flattened.slice(flattened.lastIndexOf('.'));

  if (!extension.startsWith('.')) return '';
  // A hole in the extension leaves it unknown, not ruled out: `hero.${ext}` could be
  // `hero.png`.
  if (extension.includes('*') || extension.includes('/')) return '';
  return extension.toLowerCase();
}

/**
 * Split a trailing `?query` or `#fragment` off a path, so `hero.png?v=2` becomes
 * `hero.png` and `?v=2`. A reference's range covers the path alone, and a rewrite leaves
 * the suffix where the author put it.
 */
export function splitPathSuffix(rawPath: string): { path: string; suffix: string } {
  // A leading `#` is the prefix of a Node subpath import, not a fragment. A leading `?`
  // still splits, leaving an empty path: a bare query names no file.
  const from = rawPath.startsWith('#') ? 1 : 0;

  // A `?` or `#` inside an unknown segment or a character reference is not a delimiter:
  // `${config?.style}` is an optional chain, `#{$mode}` a SCSS interpolation and `&#38;`
  // an escaped `&`. The mask hides them while every index stays valid in `rawPath`.
  const masked = maskUnknownSegments(rawPath);
  const index = masked.slice(from).search(/[?#]/);
  if (index === -1) return { path: rawPath, suffix: '' };
  return { path: rawPath.slice(0, from + index), suffix: rawPath.slice(from + index) };
}

/**
 * A same-length copy of `rawPath` with every unknown segment and character reference
 * blanked out, so a delimiter search cannot land inside one and its offsets still index
 * `rawPath`. Keep `'\u0000'` an escape: a raw NUL byte makes git and grep treat this file
 * as binary.
 */
function maskUnknownSegments(rawPath: string): string {
  return rawPath
    .replace(UNKNOWN_SEGMENT, (match) => '\u0000'.repeat(match.length))
    .replace(CHARACTER_REFERENCE, (match) => '\u0000'.repeat(match.length));
}

/** Every spelling of an unknown segment: `${…}`, `#{…}`, `@{…}`, `{{…}}` and `{%…%}`. */
const UNKNOWN_SEGMENT = /\$\{[^}]*\}|#\{[^}]*\}|@\{[^}]*\}|\{\{[^}]*\}\}|\{%[^%]*%\}/g;

/**
 * A numeric or named character reference. Its `#` is not a fragment delimiter: splitting
 * `/gallery/a&#38;b.png` there would leave `/gallery/a&`, which has no extension.
 */
const CHARACTER_REFERENCE = /&(?:#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g;

/**
 * Template syntaxes that build a path at render time, and what to call each one.
 * `couldHoldReference` reads the markers too, so a syntax added here also keeps files
 * that use it from being skipped unparsed.
 */
export const TEMPLATE_EXPRESSIONS: readonly (readonly [marker: string, name: string])[] = [
  ['{{', 'a Handlebars, Mustache, Vue or Jinja expression'],
  ['{%', 'a Liquid, Jinja or Nunjucks tag'],
  ['<%', 'an EJS or ERB expression'],
  ['${', 'a template literal expression'],
  ['#{', 'an interpolation'],
];

/**
 * Every interpolation syntax that stands for one unknown segment of a path. Adapters that
 * read a path as text decide its ceiling from these (through `interpolationChunks`) and the
 * resolver's `matchPattern` globs them, so both read this one list.
 */
export const INTERPOLATIONS = Object.freeze([
  /\$\{[^}]*\}/g, // JavaScript and Astro: `${mode}`
  /#\{[^}]*\}/g, // SCSS: `#{$mode}`
  /@\{[^}]*\}/g, // Less: `@{mode}`
]);

/**
 * The literal text between a path's unknown segments, in any of the `INTERPOLATIONS`
 * syntaxes: the chunks `assembledPathIsGlobbable` takes, read from the written text.
 */
export function interpolationChunks(rawPath: string): readonly string[] {
  let marked = rawPath;
  for (const pattern of INTERPOLATIONS) marked = marked.replace(pattern, '\u0000');
  return marked.split('\u0000');
}

/**
 * Whether an assembled path fixes enough to be matched against the files that exist.
 *
 * A pattern needs a fixed directory, because location is what makes an asset unique:
 * `${base}/hero.png` is refused however specific the rest is. It also needs at most one
 * unknown segment in the file name, since `/icons/${theme}-${size}.png` would claim
 * `icon-192.png` and `icon-512.png` while constraining almost nothing. Taking chunks
 * rather than a string lets a template literal's `quasis` and an interpolated CSS path
 * share the rule. See "The resolver's seven outcomes" in ARCHITECTURE.md.
 *
 * @param chunks the literal text between the unknown segments, in order. A path with one
 * interpolation has two chunks; either may be empty.
 */
export function assembledPathIsGlobbable(chunks: readonly string[]): boolean {
  const first = chunks[0] ?? '';
  if (!first.includes('/')) return false;

  let unknownsInName = 0;
  for (const [index, chunk] of chunks.entries()) {
    // Every chunk but the first is preceded by an unknown segment.
    if (index > 0) unknownsInName += 1;
    // A `/` here starts the filename again, so what was counted so far sat in a
    // directory segment rather than in the name.
    if (chunk.includes('/')) unknownsInName = 0;
  }

  return unknownsInName <= 1;
}

/** Why a path that fails `assembledPathIsGlobbable` is refused, worded for the report. */
export const NOT_GLOBBABLE_REASON =
  'too little of the path is fixed to match files safely; a pattern needs a fixed directory and at most one unknown part in the file name';

/**
 * How a path is spelled in the source: as written, percent-encoded (`hero%20image.png`),
 * or with HTML character references (`a&amp;b.png`).
 *
 * The resolver tries the literal spelling first, then each decoded one, and records the
 * spelling that matched, so a rewrite writes the new path back the same way (`spell`).
 * See "Percent-encoded and entity-encoded paths" in ARCHITECTURE.md.
 */
export type PathSpelling = 'literal' | 'percent-encoded' | 'html-entities';

/**
 * The named references the decoder knows, alongside numeric ones. Any other name, such as
 * `&eacute;`, leaves the path undecoded rather than half decoded.
 */
const PREDEFINED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
]);

const ENTITY = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g;

/**
 * Every spelling this path could be, literal first.
 *
 * Returns only the literal spelling when nothing is encoded, and never a partly decoded
 * path: text the decoder cannot finish contributes no candidate.
 */
export function spellingsOf(rawPath: string): ReadonlyArray<{
  readonly spelling: PathSpelling;
  readonly path: string;
}> {
  const candidates: { spelling: PathSpelling; path: string }[] = [
    { spelling: 'literal', path: rawPath },
  ];

  const entities = decodeCharacterReferences(rawPath);
  if (entities !== null && entities !== rawPath) {
    candidates.push({ spelling: 'html-entities', path: entities });
  }

  const percent = decodePercent(rawPath);
  if (percent !== null && percent !== rawPath) {
    candidates.push({ spelling: 'percent-encoded', path: percent });
  }

  return candidates;
}

/**
 * Write `path` back in `spelling`, so a rewritten reference reads the way the author
 * wrote it.
 *
 * A rewrite builds the new text from the path on disk, so without this a file called
 * `hero image.png`, referenced as `hero%20image.png`, would be rewritten with a raw space.
 */
export function spell(path: string, spelling: PathSpelling): string {
  switch (spelling) {
    case 'literal':
      return path;
    case 'percent-encoded':
      // Per segment: encoding `/` would turn the path into one oddly named file.
      return path
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
    case 'html-entities':
      // Only `&` is re-encoded. Inventing entities for the other characters would change
      // text the author did not write.
      return path.replaceAll('&', '&amp;');
    default:
      return path;
  }
}

/**
 * The text with every character reference resolved, plus a map back to source offsets, or
 * `null` when a reference is outside the bound.
 *
 * A `style` attribute's CSS can be entity-escaped (`url(&quot;/logo.png&quot;)`), and only
 * the decoded text parses as the browser reads it. `map[i]` is the source offset of decoded
 * code unit `i`, with one more entry for the end, so a decoded range `[a, b)` maps to
 * `[map[a], map[b])` and a reference's whole span belongs to the character it produced.
 * This decoder knows fewer references than the HTML parser, so `html.ts` declines when the
 * two decode an attribute differently. See "Percent-encoded and entity-encoded paths" in
 * ARCHITECTURE.md.
 */
export function decodeCharacterReferencesWithMap(
  text: string,
): { readonly text: string; readonly map: readonly number[] } | null {
  const decoded: string[] = [];
  const map: number[] = [];
  let index = 0;

  while (index < text.length) {
    ENTITY_ONCE.lastIndex = index;
    const match = text.charAt(index) === '&' ? ENTITY_ONCE.exec(text) : null;

    if (match === null || match.index !== index) {
      map.push(index);
      decoded.push(text.charAt(index));
      index += 1;
      continue;
    }

    const character = decodeOneReference(match[1] ?? '');
    if (character === null) return null;
    // Each code unit of the decoded character should map to the reference's start. But
    // `for...of` steps by code point, so an astral character (two code units) gets one
    // entry, and every entry after it sits one place early.
    for (const unit of character) {
      map.push(index);
      decoded.push(unit);
    }
    index += match[0].length;
  }

  map.push(text.length);
  return { text: decoded.join(''), map };
}

/** The entity pattern, sticky, so it can be anchored at a position rather than searched. */
const ENTITY_ONCE = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/y;

/** One reference's body to its character, or `null` when it is outside the bound. */
function decodeOneReference(body: string): string | null {
  if (body.startsWith('#')) {
    const isHex = body[1] === 'x' || body[1] === 'X';
    const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return null;
    return String.fromCodePoint(code);
  }
  return PREDEFINED_ENTITIES.get(body.toLowerCase()) ?? null;
}

/**
 * The text with every character reference resolved, or `null` when one is outside the
 * bound. A partly decoded path would be neither what the author wrote nor the file's name.
 */
function decodeCharacterReferences(text: string): string | null {
  if (!text.includes('&')) return text;

  let decodable = true;
  const decoded = text.replace(ENTITY, (match, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) {
        decodable = false;
        return match;
      }
      return String.fromCodePoint(code);
    }
    const named = PREDEFINED_ENTITIES.get(body.toLowerCase());
    if (named === undefined) {
      decodable = false;
      return match;
    }
    return named;
  });

  // An `&` outside a reference is part of the file name (`c&s.png`). Only a reference the
  // decoder cannot read makes the text undecodable.
  return decodable ? decoded : null;
}

/**
 * The text with percent-escapes resolved, or `null` when it is not valid percent-encoding.
 * `decodeURIComponent` throws on a lone `%` or a bad pair, and `100%` in a style attribute
 * reaches here.
 */
function decodePercent(text: string): string | null {
  if (!text.includes('%')) return text;
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

/**
 * Why this text cannot name a file at all, or `null` when it might.
 *
 * It rules only on what the static text proves. `/view/${style}/${item.name}` reads like
 * a route, but `item.name` could end in `.png`, and `report.${type}` could be
 * `report.png`, so both pass. Most dynamic references that are not images in practice
 * pass the same way, and catching them would mean ruling on what the text only suggests.
 */
export function provablyNotAFile(rawPath: string): string | null {
  if (rawPath.endsWith('/')) {
    return 'the path ends in `/`, so it names a directory rather than a file';
  }
  if (rawPath.startsWith('?')) {
    return 'the path begins with `?`, so it is a query string rather than a path';
  }

  const lastSegment = rawPath.slice(rawPath.lastIndexOf('/') + 1);
  if (
    lastSegment.startsWith('#') &&
    !INTERPOLATION_OPENERS.some((o) => lastSegment.startsWith(o))
  ) {
    return 'the last segment is a `#fragment`, which names a place in a document rather than a file';
  }

  return null;
}

/**
 * The three ways an interpolation opens. A last segment such as `#{$mode}.png` is a path
 * being built, not a `#fragment`.
 */
const INTERPOLATION_OPENERS: readonly string[] = ['#{', '${', '@{'];

/**
 * Why a path is built at render time rather than written literally, or `null` for a
 * plain path.
 *
 * `<img src="{{ image }}">` names no file until something renders it, so it is not a
 * broken reference. Adapters report such a path with an `unsafe` ceiling and this reason,
 * and the resolver reports it as `dynamic`.
 */
export function templateExpressionReason(rawPath: string): string | null {
  for (const [marker, name] of TEMPLATE_EXPRESSIONS) {
    if (rawPath.includes(marker)) {
      return `contains ${name}: the path is not known statically`;
    }
  }
  return null;
}

/**
 * Split a `srcset` into its candidate URLs, following the HTML parsing rules. The HTML
 * and JavaScript adapters share it, since JSX `srcSet` has the same syntax.
 *
 * Splitting on commas alone is wrong twice: a descriptor (`1x`, `800w`) follows each URL,
 * and a URL may itself end in a comma when its descriptor is omitted.
 */
export function parseSrcset(value: string): SrcsetCandidate[] {
  const candidates: SrcsetCandidate[] = [];
  let index = 0;

  while (index < value.length) {
    while (index < value.length && /[\s,]/.test(value.charAt(index))) index += 1;
    if (index >= value.length) break;

    const start = index;
    while (index < value.length && !/\s/.test(value.charAt(index))) index += 1;

    // Trailing commas belong to the separator, not to the URL.
    let end = index;
    let hadTrailingComma = false;
    while (end > start && value.charAt(end - 1) === ',') {
      end -= 1;
      hadTrailingComma = true;
    }

    const url = value.slice(start, end);

    // With no trailing comma a descriptor follows, and it runs to the next comma.
    const descriptorStart = index;
    if (!hadTrailingComma) {
      while (index < value.length && value.charAt(index) !== ',') index += 1;
    }

    if (end > start) {
      candidates.push({
        url,
        offset: start,
        descriptor: hadTrailingComma ? '' : value.slice(descriptorStart, index).trim(),
      });
    }
  }

  return candidates;
}

/**
 * One `srcset` candidate. `descriptor` is the `2x` or `800w` after the URL, or `''`.
 *
 * The descriptor only chooses the reference's shape: a density list and a width list are
 * separate shapes, because `w` descriptors come with a `sizes` attribute and fail on their
 * own. The resolver never sees it.
 */
export interface SrcsetCandidate {
  readonly url: string;
  readonly offset: number;
  readonly descriptor: string;
}

/**
 * Whether a bare string is shaped enough like a path to guess at.
 *
 * Spaces are allowed, because uploaded and dragged-in files carry them, but only alongside
 * a `/`: without one a spaced string reads as prose, like the UI label
 * `"Remove workspace.png"`, and a guess that resolves becomes a link a rewrite acts on. A
 * comma (an unsplit `srcSet` list), a tab or a newline rules a string out. A spaced name
 * with no slash, such as `{ file: 'My Logo.svg' }`, is missed; a test in
 * `javascript.test.ts` pins that. See "What counts as a path-shaped string" in
 * ARCHITECTURE.md.
 */
export function plausiblePathShape(path: string): boolean {
  if (/[\t\n\r,]/.test(path)) return false;
  if (!path.includes(' ')) return true;
  return SPACED_PATH.test(path) && path.includes('/');
}

/**
 * A string that is nothing but a path, allowing single spaces inside it.
 *
 * Anchored at both ends and finishing on an extension, so prose that runs past one
 * (`"see ./old.png for details"`) fails even though it holds a `/`. `*` stands for a
 * template hole: the JavaScript adapter joins a template literal's chunks with it.
 * Parentheses are allowed for names like `Photo (1).webp`, since a string literal is
 * already quoted; the end anchor still rejects `"url(hero one.png)"`. See "What counts as
 * a path-shaped string" in ARCHITECTURE.md.
 */
const SPACED_PATH = /^[\w@.\-/*()]+(?: [\w@.\-/*()]+)*\.[A-Za-z0-9]+$/;
