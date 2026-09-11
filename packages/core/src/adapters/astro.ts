/**
 * The Astro adapter.
 *
 * An `.astro` file is two languages in one, and it is claimed as **one adapter over
 * two existing ones** rather than as a new parser:
 *
 * ```astro
 * ---
 * import Houston from '~/assets/houston.png';   <- TypeScript (the frontmatter fence)
 * ---
 * <img src="/logo.png" />                       <- HTML (the template body)
 * ```
 *
 * ⚠️ **Both halves carry real references, and reading only one of them is the trap.**
 * Measured across the validation corpus: nine hedged assets are named by ESM imports
 * in the fence, and `RecipeLinks.astro:35` names a tenth with a plain
 * `<img src="/houston_chef.webp">` in the body. A fence-only adapter would leave that
 * one invisible and a body-only adapter would leave the other nine invisible, and in
 * both cases the assets look **dead** rather than merely unreferenced — which is the
 * failure that tells a user it is safe to delete a file their site is serving.
 *
 * **Why this is not a new parser.** The fence is TypeScript, so `findJavaScriptReferences`
 * reads it; the body is HTML-with-components, so `htmlAdapter` reads it — including
 * the `<style>` blocks it hands on to the CSS adapter. Writing a third parser here
 * would mean three places to fix the next R20.
 *
 * **Offsets stay absolute by masking, never by slicing.** Each half is handed to its
 * reader as a full-length copy of the file with the *other* half replaced by spaces,
 * so every offset a sub-adapter returns already indexes the real `.astro` file and
 * the range invariant `source.slice(start, end) === rawPath` keeps holding. Slicing
 * and re-adding a base offset would work too, and it is the version that gets an
 * off-by-one wrong at two in the morning.
 *
 * **What the body does with `src={Houston}`.** The HTML adapter emits it with the
 * braces intact, it has no image extension, and rung 3 of the resolver drops it
 * without a report line. That is correct rather than lossy: the *import* in the fence
 * is the reference to that asset, and this expression only names the binding. It is
 * listed here because it looks like a gap and is not.
 */

import type { RawReference } from '../types.js';
import { defineAdapter } from './define.js';
import { htmlAdapter } from './html.js';
import { findJavaScriptReferences } from './javascript.js';

/**
 * The frontmatter fence, if the file opens with one.
 *
 * Astro requires the fence to be the very first thing in the file, so this is
 * anchored at offset 0 and a `---` appearing later in the body cannot open one. The
 * closing delimiter must be alone on its line, which is what stops a `---` inside
 * prose or a string from ending the fence early.
 */
const FENCE = /^---[^\S\n]*\r?\n([\s\S]*?)\r?\n---[^\S\n]*(?:\r?\n|$)/d;

/** Replace every character except newlines with a space, so offsets and lines hold. */
function blank(text: string): string {
  return text.replace(/[^\n]/g, ' ');
}

export const astroAdapter = defineAdapter({
  id: 'astro',
  extensions: ['.astro'],

  findReferences({ file, text }): RawReference[] {
    const fence = FENCE.exec(text);

    // No fence at all is ordinary — six of astro-docs' 86 components have none — so
    // the body still has to be read. Treating a missing fence as a parse failure
    // would turn a normal file into a coverage gap.
    if (fence === null) {
      return htmlAdapter.findReferences({ file, text });
    }

    // The capture group's own indices, via the `d` flag — computing them from the
    // match length would have to know whether the delimiters carried a `\r` and
    // whether the file ended without a trailing newline, which is three chances to
    // be off by one in a value that decides where an edit lands.
    const [scriptStart, scriptEnd] = fence.indices?.[1] ?? [fence[0].length, fence[0].length];

    // Each reader sees a full-length file with the other half blanked.
    const scriptOnly =
      blank(text.slice(0, scriptStart)) +
      text.slice(scriptStart, scriptEnd) +
      blank(text.slice(scriptEnd));
    const bodyOnly = blank(text.slice(0, fence[0].length)) + text.slice(fence[0].length);

    // `.ts` rather than `.tsx`: an Astro fence is TypeScript and cannot contain JSX,
    // and the `.tsx` grammar reads `<Foo>` as a JSX element where `.ts` reads it as a
    // type assertion — which is what a fence actually means by it.
    const fromScript = findJavaScriptReferences({ file, text: scriptOnly, extension: '.ts' });
    const fromBody = htmlAdapter.findReferences({ file, text: bodyOnly });

    return [...fromScript, ...fromBody].sort((a, b) => a.start - b.start);
  },
});
