/**
 * Small syntactic judgements about a reference path, shared by every adapter.
 *
 * None of this is resolution — nothing here touches a disk or asks whether a file
 * exists. These functions only read the text an author wrote, which is exactly what
 * an adapter is allowed to do.
 */

import type { ReferenceKind } from '../types.js';

/**
 * A URL scheme: a letter followed by letters, digits, `+`, `-` or `.`, then a colon.
 *
 * A relative path can never match this, because a path segment containing a colon
 * before the first slash is not a thing anyone writes on purpose.
 */
const URL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Whether this text points somewhere other than a file in this project.
 *
 * Covers `data:` URIs, `https://` and friends, protocol-relative `//cdn/x.png`, and
 * bare `#fragment` references such as `url(#gradient)`, which point at an element in
 * the same document rather than at a file.
 *
 * Adapters drop these rather than reporting them. That is not a silent skip: they
 * were never candidate asset references, and reporting `url(data:image/png;base64,…)`
 * as a broken reference would be actively wrong.
 *
 * `kind` is required rather than defaulted, because a leading `#` means two opposite
 * things depending on where it appears and a default would let a call site keep the
 * wrong one silently. In a module specifier — `kind === 'import'` — `#internal/a.png`
 * is a Node subpath import and one of the alias forms the resolver handles; anywhere
 * else it is a document fragment. Dropping a subpath import here would make it vanish
 * from every report under no reason at all, which is the rule 9 failure this argument
 * exists to prevent.
 */
export function isExternalUrl(rawPath: string, kind: ReferenceKind): boolean {
  if (rawPath.startsWith('#')) {
    // A module specifier starting with `#` is an alias, not a fragment.
    if (kind === 'import') return false;
    // One exception elsewhere: `#{…}` opens a SCSS interpolation, so
    // `#{$dir}/hero.png` is a path the preprocessor builds. Treating it as a
    // fragment would drop it entirely, and a reference we silently discard is worse
    // than one we report as unsafe — the caller can see the second and act on it.
    return !rawPath.startsWith('#{');
  }
  return rawPath.startsWith('//') || URL_SCHEME.test(rawPath);
}

/**
 * Every templating hole this project recognises, as one pattern.
 *
 * `${…}` (JS and Liquid-ish), `{{…}}` (Jekyll, Hugo, Eleventy), `{%…%}` (Nunjucks,
 * Jinja) and `#{…}` (SCSS). Kept beside the reference helpers because the resolver
 * globs exactly these and so must anything reasoning about the static parts.
 */
const TEMPLATE_HOLE = /\$\{[^}]*\}|\{\{[^}]*\}\}|\{%[^%]*%\}|#\{[^}]*\}/g;

/**
 * The file extension a templated path shows **statically**, or `''` when a hole
 * hides it.
 *
 * `components/ui/${name}.tsx` shows `.tsx` — no resolution needed, the suffix is
 * right there — while `/view/${style}/${name}` shows nothing and `hero.${ext}` shows
 * nothing either, because the hole *is* the extension.
 *
 * This exists so the report can stop showing people a bucket of things that are
 * provably not images. It is deliberately **not** the resolver's rung 3: that tests a
 * fully static path and its position is pinned by tests in both directions — ahead of
 * the ceiling checks it swallows `url($hero)`, behind the asset lookup it turns every
 * `url(inter.woff2)` into a broken finding. This is a different question asked of a
 * different set of references.
 */
export function staticExtensionOf(rawPath: string): string {
  const { path } = splitPathSuffix(rawPath);
  const flattened = path.replace(TEMPLATE_HOLE, '*');
  const extension = flattened.slice(flattened.lastIndexOf('.'));

  if (!extension.startsWith('.')) return '';
  // A hole inside the extension means we cannot know it: `hero.${ext}` could be
  // anything, including a `.png`, so it must stay unknown rather than be ruled out.
  if (extension.includes('*') || extension.includes('/')) return '';
  return extension.toLowerCase();
}

/**
 * Split a trailing `?query` or `#fragment` off a path.
 *
 * `hero.png?v=2` names the file `hero.png`; the suffix is a cache-buster the
 * bundler or server reads. The reference range must cover the path alone so that
 * rewriting swaps `hero.png` for `hero.webp` and leaves `?v=2` where the author put
 * it. Reporting the whole string as the path would also make it unresolvable and
 * produce a false broken finding.
 */
export function splitPathSuffix(rawPath: string): { path: string; suffix: string } {
  // A suffix follows something, so a `#` in first position is not one — it is the
  // alias prefix of a Node subpath import, and splitting there would leave an empty
  // path that vanishes at the next check. A leading `?` has no such reading.
  const from = rawPath.startsWith('#') ? 1 : 0;

  // 🔴 **A `?` or `#` INSIDE AN UNKNOWN SEGMENT IS NOT A DELIMITER, and reading it as
  // one is how the extension filter stopped firing on templated paths.**
  // `styles/${config?.style ?? 'new-york-v4'}/${item}.json` split at the `?` of the
  // optional chain, leaving the path `styles/${config` — no extension, so
  // `staticExtensionOf` returned `''`, so `provablyNotAnAsset` could not rule out a
  // `.json` that is written right there in the source.
  //
  // ⚠️ **Masked rather than stripped, so every offset below still indexes `rawPath`.**
  // Searching a hole-free copy would give an index into the wrong string, which is the
  // class of bug this whole file exists to avoid. It is the same masking `astro.ts` uses
  // on the frontmatter fence and for the same reason.
  //
  // ⚠️ B9 made the opposite mistake here and it cost three references: `#` opens a URL
  // fragment in CSS and an INTERPOLATION in SCSS, `/theme-#{$mode}.png` was split at the
  // `#`, the extension went with the discarded half and the reference was dropped
  // entirely. Both halves of that ambiguity are now one rule in one place.
  const masked = maskUnknownSegments(rawPath);
  const index = masked.slice(from).search(/[?#]/);
  if (index === -1) return { path: rawPath, suffix: '' };
  return { path: rawPath.slice(0, from + index), suffix: rawPath.slice(from + index) };
}

/**
 * A same-length copy of `rawPath` with every unknown segment and every character
 * reference replaced by filler, so a search for a delimiter cannot land inside one.
 *
 * Same length by construction — the offsets it returns are offsets into the original.
 */
function maskUnknownSegments(rawPath: string): string {
  return rawPath
    .replace(UNKNOWN_SEGMENT, (match) => '\u0000'.repeat(match.length))
    .replace(CHARACTER_REFERENCE, (match) => '\u0000'.repeat(match.length));
}

/** Every unknown-segment spelling, as one pattern. Kept beside the masker it serves. */
const UNKNOWN_SEGMENT = /\$\{[^}]*\}|#\{[^}]*\}|@\{[^}]*\}|\{\{[^}]*\}\}|\{%[^%]*%\}/g;

/**
 * 🔴 **A CHARACTER REFERENCE CONTAINS A `#`, AND THAT COST `path.charref` TWO OF ITS
 * FOUR ENTRIES.** `/gallery/a&#38;b.png` was split at the `#` of its own numeric reference,
 * leaving the path `/gallery/a&` — no extension, so rung 3 dropped it. The named form
 * `&amp;` resolved perfectly, which is exactly what made the row look like a partial
 * success rather than one rule missing one encoding.
 *
 * ⚠️ **One rule, three encodings.** A `?` or `#` inside an interpolation, inside a
 * template tag, or inside a character reference is not a delimiter — it is a character of
 * the encoded unit. Fixing them on three different days is how the third one stayed broken.
 */
const CHARACTER_REFERENCE = /&(?:#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g;

/** Template syntaxes that build a path at render time, and what to call each one. */
// Exported for `could-hold-reference.ts` (R165), which must not skip the parse of a file
// holding one of these: a templated destination is a reference position asserted with no
// static extension, and it reaches the report as `dynamic`. A hand-kept second copy of
// this table would drift: a sixth dialect added here has to protect the skip
// automatically, or the skip silently starts eating the new dialect's report lines.
export const TEMPLATE_EXPRESSIONS: readonly (readonly [marker: string, name: string])[] = [
  ['{{', 'a Handlebars, Mustache, Vue or Jinja expression'],
  ['{%', 'a Liquid, Jinja or Nunjucks tag'],
  ['<%', 'an EJS or ERB expression'],
  ['${', 'a template literal expression'],
  ['#{', 'an interpolation'],
];

/**
 * Whether an assembled path still constrains a glob enough to be checked against the
 * files that exist, given the STATIC chunks between its unknown segments.
 *
 * 🔴 **This is R78 Q3 and R80(b) as one rule, in one place, because it is now asked in
 * two dialects.** A pattern needs:
 *   1. a fixed DIRECTORY — location is what makes an asset unique, so `${base}/hero.png`
 *      is not globbable however specific the rest is; and
 *   2. **enough of a fixed NAME that the glob cannot sweep in strangers.** One unknown
 *      segment in the name is a pattern; two is a guess. `/icons/${theme}-${size}.png`
 *      would claim `icon-192.png` and `icon-512.png` on a pattern constraining almost
 *      nothing.
 *
 * ⚠️ **Chunks, not a marker to search for**, so one function serves a template literal's
 * `quasis` and a `${}`-bearing string from CSS-in-JS without either caller re-deriving
 * the rule. Condition 2 was implemented nowhere for a day after it was ruled, and the
 * reason it went unnoticed is that each caller had its own half of the rule (R89).
 *
 * @param chunks the literal text between the unknown segments, in order. A path with one
 * interpolation has two chunks; either may be empty.
 */
/**
 * Every interpolation syntax that stands for one unknown segment of a path.
 *
 * 🔴 **`matchPattern` KNEW ONLY THE FIRST OF THESE, WHICH IS HALF OF WHY R80(b) NEVER
 * REACHED SCSS.** The resolver's glob replaced `${…}` and nothing else, so even a
 * correctly-ceilinged `#{$mode}` path would have globbed for a literal `#{$mode}` and
 * matched nothing. Listed once, here, and used by both the adapter that decides the
 * ceiling and the resolver that acts on it — the two halves being separate is precisely
 * what R89 found last time.
 */
export const INTERPOLATIONS = Object.freeze([
  /\$\{[^}]*\}/g, // JavaScript and Astro: `${mode}`
  /#\{[^}]*\}/g, // SCSS: `#{$mode}`
  /@\{[^}]*\}/g, // Less: `@{mode}`
]);

/**
 * The literal text between a path's unknown segments, for any of the three syntaxes.
 *
 * ⚠️ Shared so that the ceiling decision and the glob are made from the SAME chunks. The
 * JavaScript adapter derived its chunks from Babel's parsed `quasis` while the CSS adapter
 * had no chunks at all; deriving both from the written text is what lets one rule govern
 * three dialects.
 */
export function interpolationChunks(rawPath: string): readonly string[] {
  let marked = rawPath;
  for (const pattern of INTERPOLATIONS) marked = marked.replace(pattern, '\u0000');
  return marked.split('\u0000');
}
// ⚠️ `'\u0000'` as an ESCAPE SEQUENCE, not a raw NUL byte. Two raw ones used to
// sit in the lines above, and they made this whole file BINARY to `grep`, `git diff`
// and every review tool — a real cost for a character nobody can see on the page.
// Identical value, greppable file.

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
 * Why this path is built at render time rather than written literally, or `null` if
 * it is a plain path.
 *
 * A templated `src` is not a broken reference — nobody typed a path that points at
 * nothing. It is a path that does not exist until something renders, so the honest
 * answer is `unsafe` with a reason, which the resolver turns into `dynamic`.
 * Reporting `<img src="{{ image }}">` as broken would be a false positive of exactly
 * the kind the audit must have none of.
 */
/**
 * Why this text cannot name a file at all, or `null` when it might.
 *
 * 🔴 **R108, and it is the third phantom population after R99's.** The engine collects a
 * JSX or template-literal `src` regardless of whether the result could ever be an image,
 * because R78 Q1's extension filter has nothing to test — *a dynamic path has no
 * extension to filter on*. So `` <iframe src={`/scratch2/${projectId}/adminpanel/`}> ``
 * became an `unsafe` reference, was counted as something we could not handle, and
 * **hedged nothing, because there is no asset behind it.**
 *
 * ✅ **Every rule here decides on what the static text PROVES, never on what it
 * suggests** — the same discipline as R80(b)'s *one unknown segment is a pattern, two is
 * a guess*:
 *
 * | | proof |
 * |---|---|
 * | ends in `/` | a directory. Whatever the holes interpolate to, nothing follows the slash |
 * | begins with `?` | a query string. There is no path part at all |
 * | its last `/`-segment begins with `#` | a fragment, which names a place in a document |
 *
 * 🔴 **`/view/${styleName}/${item.name}` IS NOT IN THAT LIST AND MUST NOT BE**, even
 * though reading the repository shows it is a route. `item.name` could end in `.png`.
 * The same protection keeps `` `report.${type}` `` — `${type}` could be `png`, making
 * `report.png`. **We rule on the text; we do not rule on what we happen to know.**
 *
 * ⚠️ **AND THAT IS WHY THIS FUNCTION CANNOT REACH R108's HEADLINE, WHICH IS WORTH SAYING
 * PLAINLY RATHER THAN QUIETLY MISSING.** R108 reports *133 of 142 non-charref `dynamic`
 * references can never be an image*, and that is true — it was established by reading all
 * 142 one at a time. Measured on the same corpus, these three rules catch **3**. The
 * difference is not a weaker implementation of the same idea: *what a human reader
 * concludes from a repository* and *what the static text proves* are two different
 * populations, and only the second can be a rule. **Closing the gap would mean ruling on
 * what the text suggests, which is the one thing R108 forbids.**
 *
 * ⚠️ **`#{`, `${` and `@{` open an INTERPOLATION, not a fragment.** `#{$mode}.png` is a
 * path SCSS builds, and reading its `#` as a fragment marker would drop a real reference
 * — the mistake B9 made in the other direction when `splitPathSuffix` split
 * `/theme-#{$mode}.png` at the `#` and lost the extension.
 */
/**
 * How a path's TEXT spells characters that are not literally themselves.
 *
 * 🔴 **The whole family — `path.charref`, `html.percent-encoded`, `md.style-attribute` —
 * is one decision: DECODE BEFORE YOU DECIDE, AND KEEP THE RANGE HONEST.** Three rules
 * hold it together and none of them may be dropped:
 *
 * 1. **`rawPath` stays the SOURCE text, always.** The range invariant is
 *    `source.slice(start, end) === rawPath`, it has held for 127,288 checks, and it is
 *    the strongest number this project owns. Decoding into `rawPath` would break it on
 *    every entry in this family at once. So the decoded form is never stored; it is
 *    *tried*, and the reference records which spelling answered.
 * 2. **The literal spelling is tried FIRST.** `enc%20name.png` is a real file whose name
 *    contains a percent sign, and `hero image.png` is a different real file reached by
 *    writing `hero%20image.png`. The coverage tree holds both on purpose: an engine that
 *    never decodes gets the second wrong and one that always decodes gets the first
 *    wrong. **Only trying both, in this order, passes.**
 * 3. 🔴 **A path we cannot FULLY decode is not claimed at all.** If one `&…;` in the text
 *    is outside the set below, the reference stays `unsafe` rather than becoming a
 *    lookup that will miss. **A miss at that point is not a shrug — it is a `broken`
 *    finding**, and a false `broken` is the one outcome this project promises never to
 *    produce. Declining is free; guessing is not.
 *
 * ⚠️ **THE BOUND ON (3), STATED RATHER THAN HIDDEN (R74's habit).** The decoder here
 * knows numeric character references — `&#38;` and `&#x26;` — and the five predefined
 * names `&amp; &lt; &gt; &quot; &apos;`. It does NOT know the other ~2,200 HTML named
 * entities. A filename containing `&eacute;` therefore stays `unsafe` exactly as it does
 * today: **no regression, and a refusal with a record rather than a wrong answer.**
 * Widening it means a dependency on the `entities` table, which is a real option and is
 * not taken on a corpus that contains zero such paths.
 */
export type PathSpelling = 'literal' | 'percent-encoded' | 'html-entities';

/** A named reference we are willing to decode, and what it stands for. */
const PREDEFINED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
]);

const ENTITY = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g;

/**
 * Every spelling this text could be, literal first.
 *
 * Returns one entry when nothing is encoded, and never returns a partially decoded
 * string: a text the decoder cannot finish contributes no candidate at all.
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
 * 🔴 **This is the half that makes the decode safe to ship.** `relocate.ts` builds a
 * reference's new text from `move.to`, which is the ON-DISK path — so a file genuinely
 * named `hero image.png`, reached through `hero%20image.png`, would be rewritten with a
 * **raw space inside a URL**. Resolving these is what makes them rewritable, so the
 * decode and the re-encode are one change and not two.
 */
export function spell(path: string, spelling: PathSpelling): string {
  switch (spelling) {
    case 'literal':
      return path;
    case 'percent-encoded':
      // Per SEGMENT: `/` is structure, not content, and encoding it would turn one path
      // into one very oddly named file.
      return path
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
    case 'html-entities':
      // Only `&` is re-encoded. The others in the table cannot appear unescaped in an
      // attribute value we located, and inventing entities for them would change text
      // the author did not write.
      return path.replaceAll('&', '&amp;');
    default:
      return path;
  }
}

/**
 * The text with every character reference resolved, PLUS the map back to where each
 * decoded character came from.
 *
 * 🔴 **This is what lets an entity-escaped style attribute be read at all, and the map
 * is the whole of why it is safe.** `style="background-image: url(&quot;/logo.png&quot;)"`
 * is CSS the HTML parser has already decoded, so handing the SOURCE text to PostCSS gives
 * `&quot;/logo.png&quot;` as an unquoted token — extension `.png&quot;`, dropped by rung 3.
 * Handing it the DECODED text parses correctly and returns offsets into a string that is
 * not the file.
 *
 * ⚠️ **`map[i]` is the source offset of decoded character `i`, and the array is one
 * longer than the text** so a half-open decoded range `[a, b)` maps to the source range
 * `[map[a], map[b])`. An entity contributes its whole span to the one character it
 * produced, which is what makes a range that starts or ends inside a decoded region land
 * on the entity boundary rather than in the middle of `&quot;`.
 *
 * 🔴 **The caller must still check the result against the parser's own decoded value
 * before trusting it (see `html.ts`), and refuse when they differ.** This decoder knows a
 * bounded set of references; the HTML parser knows all of them. Where they disagree the
 * honest answer is to decline, because the alternative is a range that points at the wrong
 * characters — and 0 range-invariant failures over 127,288 checks is the strongest number
 * this project owns.
 *
 * Returns `null` when a reference is outside the bound, exactly as the plain decoder does.
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
    // Every code unit of the decoded character maps to the START of the reference, and
    // the sentinel below carries its end. A reference producing a surrogate pair is
    // therefore still addressable as one span.
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
 * The text with every character reference resolved, or `null` when one of them is
 * outside the bound above.
 *
 * ⚠️ `null` is the third outcome and it is the important one (R86). Returning the
 * partially decoded string would hand the resolver a path that is neither what the
 * author wrote nor what the file is called.
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

  // An `&` that is not part of a reference we resolved is an `&` in the filename, which
  // is fine — `c&s.png` is a real file in the validation corpus. What is NOT fine is a
  // reference we recognised the shape of and could not read.
  return decodable ? decoded : null;
}

/**
 * The text with percent-escapes resolved, or `null` when the text is not valid
 * percent-encoding.
 *
 * ⚠️ `decodeURIComponent` THROWS on a lone `%` or a bad hex pair, and a throw is a third
 * outcome rather than a miss (R86). `100%` in a style attribute reaches here.
 */
function decodePercent(text: string): string | null {
  if (!text.includes('%')) return text;
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

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

/** The three spellings of "an unknown segment starts here", for the fragment test. */
const INTERPOLATION_OPENERS: readonly string[] = ['#{', '${', '@{'];

export function templateExpressionReason(rawPath: string): string | null {
  for (const [marker, name] of TEMPLATE_EXPRESSIONS) {
    if (rawPath.includes(marker)) {
      return `contains ${name}: the path is not known statically`;
    }
  }
  return null;
}

/**
 * Split a `srcset` into its candidate URLs, following the HTML parsing rules.
 *
 * Shared by the HTML and JavaScript adapters, because JSX `srcSet` holds exactly
 * the same syntax. Emitting it unsplit produces two false positives at once: the
 * whole string resolves to nothing (a `broken` finding), and every image in it
 * but the first gains no reference at all and looks dead.
 *
 * Splitting on commas alone is wrong twice over: a descriptor (`1x`, `800w`) follows
 * each URL, and a URL may itself end in a comma when its descriptor is omitted.
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
 * One `srcset` candidate.
 *
 * `descriptor` is the `2x` or `800w` that follows the URL, empty when there is none.
 * It is returned rather than skipped because it decides the reference's SHAPE — a
 * density list and a width list are different rows in the coverage matrix, and they
 * fail separately: `w` descriptors come with a `sizes` attribute and `x` ones do not.
 * Nothing else uses it, and the resolver never sees it.
 */
export interface SrcsetCandidate {
  readonly url: string;
  readonly offset: number;
  readonly descriptor: string;
}

/**
 * Whether a bare string is shaped enough like a path to guess at (R26).
 *
 * ⚠️ **The line this replaces said `a path never contains whitespace`, and that is
 * simply false.** Spaces come from every CMS upload and every dragged-in file, so
 * `["/ncc/Firing Practice.webp"]` yielded nothing and the asset came back a confident
 * `dead` — *"safe to delete"* about a file on a live site. The claim was stated as fact
 * in a comment, which is why nobody questioned it.
 *
 * A comma still disqualifies: that is the unsplit `srcSet` shape
 * (`"/a.jpg 1x, /b.jpg 2x"`), which is a list rather than a path. So are tabs and
 * newlines, which no real path carries.
 *
 * **A space is allowed only alongside a `/`, and that rule is measured rather than
 * guessed.** Two repositories point opposite ways and separate cleanly:
 *
 * - `D:/RBU/RBU-Website`: **109** quoted image paths contain a space, and **109 of 109
 *   contain a slash.** Every real case is a served path.
 * - `shadcn-ui`: **87** quoted strings contain a space and end in an image extension,
 *   and **0 of 87 contain a slash.** All 13 distinct values are accessible UI labels —
 *   `"Remove workspace.png"`, `"Open desk-reference.jpg"`. Prose, not paths.
 *
 * Without the slash, a spaced string is indistinguishable from a sentence, and treating
 * one as a reference risks the expensive direction: a speculative string that *resolves*
 * becomes a real link Phase 2 will rewrite.
 *
 * ⚠️ **The known limit, deliberately not widened:** a bare spaced filename with no
 * separator — `{ file: 'My Logo.svg' }`, R14's shape with a space in it — stays
 * invisible. **Measured frequency across all four repositories: zero.** It is pinned by
 * a test in `javascript.test.ts` so the gap is written down rather than silent, and
 * widening it is one clause here.
 */
export function plausiblePathShape(path: string): boolean {
  if (/[\t\n\r,]/.test(path)) return false;
  if (!path.includes(' ')) return true;
  return SPACED_PATH.test(path) && path.includes('/');
}

/**
 * A string that is *nothing but* a path, allowing single spaces inside it.
 *
 * ⚠️ **The slash rule alone was not enough, and the suite caught it.** `never mistakes
 * text for code` failed on three cases that contain both a space and a slash:
 *
 * ```
 * "see ./old.png for details"        prose in an object property
 * `we removed ./old.png last week`   prose in a template
 * "import logo from './old.png'"     an import statement quoted as text
 * ```
 *
 * What separates those from `/ncc/Firing Practice.webp` is not the slash — it is that
 * **prose continues after the extension.** So the pattern is anchored at both ends and
 * must finish on a real extension: `.` followed only by letters or digits. That rejects
 * `.png for details` (spaces after the dot) and `.png'` (a trailing quote), while
 * `.webp` and `.jpg` pass.
 *
 * `*` is in the character class because `collectSpeculativeTemplate` joins its holes with
 * one, so `` `/gallery/Firing Practice ${n}.webp` `` arrives here as
 * `/gallery/Firing Practice *.webp`.
 *
 * ⚠️ **`(` and `)` are here, and only here — this is a per-syntax fix, not a global one.**
 * `WhatsApp Image 2026-03-11 at 1.29.35 PM (1).webp` is what a phone screenshot plus a
 * browser's duplicate-download suffix produces, and it is the commonest way a
 * non-developer gets an image into a repository. Measured on `RBU-Website`: **9 images
 * carry a paren and 4 of them were referenced and reported `dead` anyway** — 0.7% of 553.
 *
 * A string literal is already a quoted context, so a paren inside it is an ordinary
 * character. **It is not one everywhere else**: in unquoted CSS `url(…)` and in bare
 * Markdown `![](…)` a paren is the closing delimiter, and admitting it there breaks the
 * parse rather than widening it. Both of those have quoted and angle-bracket forms that
 * already carry such a name correctly, so nothing is lost by leaving them alone. Measured:
 * of twelve reference positions, **only the bare string literal lost a paren path**.
 *
 * The end anchor is what keeps this safe. `"url(hero.png)"` as a bare JS string ends on
 * `)`, not on an extension, so it is still rejected — the widening admits filenames, not
 * function calls.
 *
 * Note that `extensionOf` cannot do this job: `extname('see ./old.png for details')`
 * returns `'.png for details'`, which is non-empty, so the extension check upstream was
 * satisfied by prose all along — the old whitespace ban was what had been hiding it.
 */
const SPACED_PATH = /^[\w@.\-/*()]+(?: [\w@.\-/*()]+)*\.[A-Za-z0-9]+$/;
