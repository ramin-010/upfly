/**
 * Small syntactic judgements about a reference path, shared by every adapter.
 *
 * None of this is resolution — nothing here touches a disk or asks whether a file
 * exists. These functions only read the text an author wrote, which is exactly what
 * an adapter is allowed to do.
 */

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
 */
export function isExternalUrl(rawPath: string): boolean {
  if (rawPath.startsWith('#')) {
    // One exception: `#{…}` opens a SCSS interpolation, so `#{$dir}/hero.png` is a
    // path the preprocessor builds, not a fragment. Treating it as a fragment would
    // drop it entirely, and a reference we silently discard is worse than one we
    // report as unsafe — the caller can see the second and act on it.
    return !rawPath.startsWith('#{');
  }
  return rawPath.startsWith('//') || URL_SCHEME.test(rawPath);
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
  const index = rawPath.search(/[?#]/);
  if (index === -1) return { path: rawPath, suffix: '' };
  return { path: rawPath.slice(0, index), suffix: rawPath.slice(index) };
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
