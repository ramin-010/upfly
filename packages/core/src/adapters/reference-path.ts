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
  const index = rawPath.slice(from).search(/[?#]/);
  if (index === -1) return { path: rawPath, suffix: '' };
  return { path: rawPath.slice(0, from + index), suffix: rawPath.slice(from + index) };
}

/** Template syntaxes that build a path at render time, and what to call each one. */
const TEMPLATE_EXPRESSIONS: readonly (readonly [marker: string, name: string])[] = [
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
