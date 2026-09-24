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
 * So the list is four families, and each one was added because something got past the
 * list as it stood:
 * 1. Every extension `paths.ts`'s `IMAGE_EXTENSIONS` tracks.
 * 2. The constructs that assert a reference position independent of any extension:
 *    `url(`/`image-set(` (CSS, and CSS-in-JS via `javascript.ts`'s
 *    `collectFromTaggedTemplate`), the attribute names that gate a reference position
 *    for the HTML/JSX/Astro adapters (`src`, `href` — which also covers `xlink:href`
 *    — `poster`, `style`, which also covers `styled`), and the CSS-in-JS tag
 *    identifiers not already covered by `style`.
 * 3. `ENCODED_SPELLING_TOKENS` — because the extension need not be spelled literally
 *    (R164/R165). See its own comment; this is the family that produced a P0.
 * 4. `TEMPLATE_TOKENS` — because a templated destination is a reference position with
 *    no static extension at all, reported as `dynamic`.
 *
 * 🔴 **THE SKIP IS PER FILE, WHICH IS WHAT ANY REFUTING TEST HAS TO RESPECT.** One token
 * anywhere in a document parses the whole document, so a fixture holding several
 * spellings together cannot show which of them the list actually handles — the coverage
 * tree carries `encoded-entity.md`, `encoded-percent-dot.md` and
 * `encoded-percent-letter.md` as three separate documents for exactly that reason, and
 * the first attempt at them, as one file, read identically whether the fix was right or
 * wrong.
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
 * ⚠️ **Since R167 it is reachable, where before it was not:** the three skippable
 * adapters read no CSS-in-JS at all until `.mdx` ESM started going to the JavaScript
 * adapter, so the gap needs a bare-`css` block inside an MDX `export`. Still accepted,
 * for the same reason. The other markdown exception R167 introduced — a token-free
 * `.mdx` whose ESM will not parse — is stated at `scan.ts`'s `SKIPPABLE_ADAPTER_ID_SET`.
 */

import { TEMPLATE_EXPRESSIONS } from './adapters/reference-path.js';
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

/**
 * 🔴 **The extension does not have to be spelled literally, and missing that was R164.**
 *
 * `resolve.ts` asks `spellingsOf` for every spelling of a path before testing the
 * extension, so a reference resolves if the LITERAL, the ENTITY-DECODED or the
 * PERCENT-DECODED form ends in a tracked extension. `![alt](hero&#46;png)` and
 * `![alt](hero%2Epng)` hold no `.png` anywhere and both resolve to a real asset — so the
 * skip dropped a reference the markdown adapter does find, with no error and no report
 * line. That is the under-approximation this module's own header calls a P0, and the
 * coverage tree could not refute it because it held no markdown entry with an encoded
 * extension.
 *
 * - **`&#` is complete for the entity class.** `PREDEFINED_ENTITIES` is only
 *   `{amp, lt, gt, quot, apos}` → `& < > " '`, none of which can appear in an extension,
 *   so any entity that hides one is numeric (`&#46;`, `&#x2E;`) and carries `&#`.
 * - 🔴 **`%` is the token for the percent class, NOT `%2`.** R164 ruled `%2` from two
 *   probed spellings where the DOT is escaped, but `decodePercent` runs
 *   `decodeURIComponent` over the whole path, so any character can be escaped:
 *   `hero.%70ng` decodes to `hero.png`, resolves, and holds no `%2`. Fixing the two
 *   spellings that were probed rather than the class they belong to would be the same
 *   mistake one level down.
 */
const ENCODED_SPELLING_TOKENS: readonly string[] = ['&#', '%'];

/**
 * A templated destination is a reference position asserted with NO static extension.
 *
 * `![logo]({{ site.logo }})` reaches the report as `dynamic` today — the markdown adapter
 * emits it `ceiling: 'unsafe'`, and `resolve.ts` only drops such a reference when
 * `provablyNotAnAsset`, which needs a static extension to be sure. Skipping the file
 * deletes that line, which is the `url($icon-path)` case again in another dialect.
 * Imported rather than copied so a sixth dialect protects this automatically.
 */
const TEMPLATE_TOKENS: readonly string[] = TEMPLATE_EXPRESSIONS.map(([marker]) => marker);

const TOKENS: readonly string[] = [
  ...IMAGE_EXTENSIONS.map((extension) => extension.toLowerCase()),
  ...ASSERTING_TOKENS,
  ...ENCODED_SPELLING_TOKENS,
  ...TEMPLATE_TOKENS,
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
