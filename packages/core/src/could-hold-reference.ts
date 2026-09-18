/**
 * Can this file's text possibly hold a reference an adapter could find?
 *
 * `markdown.ts`'s `MARKUP_OPENER` proved the shape once (R124/R134): a substring test
 * is thousands of times cheaper than a parse, and a document with none of the tokens a
 * reference is built from cannot yield one, so the parse is skippable. **This
 * generalises that idea (R162)** — but only to `html`, `json` and `markdown` in
 * `scan.ts`'s `parseOne`, never to `css`, `javascript` or `astro`. Those three wrap a
 * real parser (postcss, Babel) that rejects syntactically invalid input on ITS OWN
 * terms, independent of whether a reference is anywhere in the file, and §5.1(e)
 * requires that failure to keep reaching the report as `parse-failed` even when the
 * text holds none of these tokens (`hostile.test.ts`'s `broken.scss` is exactly that
 * case). This module only answers "could a reference exist here" — whether the caller
 * may also treat "no" as "and it will not throw" is a per-adapter fact this module does
 * not know, so the caller (`scan.ts`) restricts it to the three adapters where that
 * second fact independently holds.
 *
 * ⚠️ **The token list is the whole risk surface, so it is not just "every image
 * extension".** A reference can be asserted by CONSTRUCT with no extension anywhere in
 * the file: `url($icon-path)` in SCSS, or a CSS-in-JS `styled.div` block that fails to
 * parse. Both reach the report today (rule 9 — a `dynamic`/`unsafe` finding, never a
 * silent drop) via `resolve.ts`'s `ceiling: 'unsafe'` path, and neither needs a static
 * extension to exist. Missing that case would turn a performance change into a
 * correctness regression: a real reported finding vanishing with no error.
 *
 * So the list is two families:
 * 1. Every extension `paths.ts`'s `IMAGE_EXTENSIONS` tracks. `resolve.ts`'s step 3
 *    (`isImageExtension(extensionOf(candidate))`) never guesses an extension that is
 *    not literally in the text, so a reference that *does* resolve always carries one.
 * 2. The constructs that assert a reference position independent of any extension:
 *    `url(`/`image-set(` (CSS, and CSS-in-JS via `javascript.ts`'s
 *    `collectFromTaggedTemplate`), the attribute names that gate a reference position
 *    for the HTML/JSX/Astro adapters (`src`, `href` — which also covers `xlink:href`
 *    — `poster`, `style`, which also covers `styled`), and the CSS-in-JS tag
 *    identifiers not already covered by `style`.
 *
 * Deliberately coarse in the same direction `MARKUP_OPENER` is coarse: `style` matches
 * the English word "styling" in prose just as readily as a `style=` attribute, which
 * only ever costs a needless parse — never a missed reference. An UNDER-approximation
 * here is a P0 (rule 9); an OVER-approximation is a missed optimisation, which is the
 * safe direction to err in.
 *
 * ⚠️ **Known residual gap, accepted rather than closed:** a CSS-in-JS block tagged
 * with the bare `css` template tag (not `styled`, `keyframes`, `createGlobalStyle` or
 * `injectGlobal`) whose body fails to parse, contains no `url(`/`image-set(`, and
 * whose file contains none of the other tokens, would be skipped along with its
 * `unsafe`/`dynamic` finding. `css` itself is not a token here because it is common
 * English and common code (`import './x.css'`, `className`, comments) and would gut
 * the skippable share for very little safety gained — this gap is narrower than any
 * case the coverage tree currently exercises.
 */

import { IMAGE_EXTENSIONS } from './paths.js';

const ASSERTING_TOKENS: readonly string[] = [
  'url(',
  'image-set(',
  'src',
  'href',
  'poster',
  'style',
  'keyframes',
  'createglobalstyle',
  'injectglobal',
];

const TOKENS: readonly string[] = [
  ...IMAGE_EXTENSIONS.map((extension) => extension.toLowerCase()),
  ...ASSERTING_TOKENS,
];

/**
 * `false` means: no adapter run over this text could produce a reference, certain or
 * dynamic. `true` is the safe default whenever that cannot be shown.
 */
export function couldHoldReference(text: string): boolean {
  const lowered = text.toLowerCase();
  for (const token of TOKENS) {
    if (lowered.includes(token)) return true;
  }
  return false;
}
