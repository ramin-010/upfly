/**
 * Whether a file's text could hold a reference any adapter would find.
 *
 * A substring check is far cheaper than a parse, so `scan.ts` skips parsing html, json and
 * markdown files that fail it. It is not used for css, javascript or astro: their parsers
 * can reject a file that holds no reference, and that failure must still reach the report.
 *
 * The token list is the risk. A reference can exist with no image extension in the file
 * (`url($icon-path)` in SCSS), so every such construct needs a token here, or the skip
 * drops a finding silently. See "Skipping files that cannot hold a reference" in
 * ARCHITECTURE.md.
 */

import { TEMPLATE_EXPRESSIONS } from './adapters/reference-path.js';
import { IMAGE_EXTENSIONS } from './paths.js';

// Constructs that mark a reference position without an extension. `href` also matches
// `xlink:href`, and `style` matches `styled`.
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

// The resolver also tries a path's entity-decoded and percent-decoded spellings, so an
// extension can be written `hero&#46;png` or `hero%2Epng`. No named entity spells an
// extension character, so `&#` covers entities. Percent-decoding applies to every
// character (`hero.%70ng` is `hero.png`), so the token is `%`, not `%2`.
const ENCODED_SPELLING_TOKENS: readonly string[] = ['&#', '%'];

// A templated destination such as `![logo]({{ site.logo }})` is reported as `dynamic` and
// has no static extension. Imported, so a new template syntax is covered here too.
const TEMPLATE_TOKENS: readonly string[] = TEMPLATE_EXPRESSIONS.map(([marker]) => marker);

const TOKENS: readonly string[] = [
  ...IMAGE_EXTENSIONS.map((extension) => extension.toLowerCase()),
  ...ASSERTING_TOKENS,
  ...ENCODED_SPELLING_TOKENS,
  ...TEMPLATE_TOKENS,
];

/**
 * `false` means no adapter run over this text could produce a reference, certain or
 * dynamic. `true` is the safe answer whenever that cannot be shown.
 */
export function couldHoldReference(text: string): boolean {
  const lowered = text.toLowerCase();
  for (const token of TOKENS) {
    if (lowered.includes(token)) return true;
  }
  return false;
}
