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
  for (const pattern of INTERPOLATIONS) marked = marked.replace(pattern, ' ');
  return marked.split(' ');
}

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
