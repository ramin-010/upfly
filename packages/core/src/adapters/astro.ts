/**
 * The Astro adapter. An `.astro` file is two languages, each read by an existing adapter:
 *
 * ```astro
 * ---
 * import Houston from '~/assets/houston.png';   <- TypeScript, for the JavaScript adapter
 * ---
 * <img src="/logo.png" />                       <- HTML, for the HTML adapter
 * ```
 *
 * Both halves hold real references, and an asset named only in an unread half would be
 * reported dead while the site serves it. Each adapter gets the whole file with the other
 * half blanked, so every offset it returns already indexes the `.astro` file.
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

    // A file with no fence is ordinary, so the body is still read. Treating a missing
    // fence as a parse failure would turn a normal file into a coverage gap.
    if (fence === null) {
      return htmlAdapter.findReferences({ file, text });
    }

    // The capture group's own indices, from the `d` flag. Computing them from the match
    // length would have to allow for a `\r` in either delimiter and a file with no final
    // newline, in a value that decides where an edit lands.
    const [scriptStart, scriptEnd] = fence.indices?.[1] ?? [fence[0].length, fence[0].length];

    const scriptOnly =
      blank(text.slice(0, scriptStart)) +
      text.slice(scriptStart, scriptEnd) +
      blank(text.slice(scriptEnd));
    const bodyOnly = blank(text.slice(0, fence[0].length)) + text.slice(fence[0].length);

    // `.ts` rather than `.tsx`: an Astro fence is TypeScript and cannot contain JSX,
    // and the `.tsx` grammar reads `<Foo>` as a JSX element where `.ts` reads it as a
    // type assertion, which is what a fence means by it.
    const fromScript = findJavaScriptReferences({ file, text: scriptOnly, extension: '.ts' }).map(
      asFenceShape,
    );
    const fromBody = readBody(file, bodyOnly);

    return [...fromScript, ...fromBody].sort((a, b) => a.start - b.start);
  },
});

/**
 * The template body: HTML, except that an attribute value in braces is JavaScript.
 *
 * Each braced value goes to the JavaScript adapter, as the fence does, one attribute at a
 * time, so ``src={`/theme-${mode}.png`}`` is a pattern matching every file it can name, as
 * it is in a `.tsx` file. `src={Houston}` yields nothing, correctly: the fence's `import`
 * is the reference to that asset, and the expression only names the binding.
 */
function readBody(file: string, body: string): RawReference[] {
  return htmlAdapter
    .findReferences({ file, text: body })
    .flatMap((reference) => readExpression(file, body, reference) ?? [asBodyShape(reference)]);
}

/**
 * Re-read a `{…}` attribute value as a JSX attribute, or `null` to keep what HTML found.
 *
 * The JavaScript adapter is handed `<x src={…}/>`: the expression exactly where it sits,
 * with a synthetic element written into the blanked text around it, so every offset it
 * returns is already an offset into the `.astro` file. A `srcset` value is written as
 * `srcSet`, so its candidate list is still split.
 *
 * `null` whenever there is doubt, which keeps the HTML reading: a value parse5 cut short
 * (an expression with spaces arrives as `{cond`, not braced at both ends), no room to
 * write the element, or an expression Babel rejects.
 */
function readExpression(
  file: string,
  body: string,
  reference: RawReference,
): RawReference[] | null {
  const { start, end, rawPath } = reference;
  if (!rawPath.startsWith('{') || !rawPath.endsWith('}') || rawPath.length < 3) return null;

  const opener = reference.shape.includes('srcset') ? '<x srcSet=' : '<x src=';
  if (start < opener.length || end + 2 > body.length) return null;
  const synthetic = `${blank(body.slice(0, start - opener.length))}${opener}${body.slice(start, end)}/>`;

  try {
    return findJavaScriptReferences({ file, text: synthetic, extension: '.tsx' }).map(
      asExpressionShape,
    );
  } catch {
    return null;
  }
}

/**
 * Re-stamp what an expression yielded. A literal path is a body literal, as it is when
 * HTML finds it; a template keeps the pattern row, because the glob rule is what can fail
 * there and it fails identically wherever it runs.
 */
function asExpressionShape(reference: RawReference): RawReference {
  return reference.shape === 'js.jsx.attribute' || reference.shape === 'js.jsx.srcset'
    ? { ...reference, shape: 'astro.template.literal' }
    : reference;
}

/**
 * Re-stamp what the JavaScript adapter found in the frontmatter fence.
 *
 * An `import` becomes `astro.import.frontmatter`, because what would break it is Astro's
 * fence extraction: get the fence boundaries wrong and every import in it goes, in a way
 * no `.ts` file would show. A path-shaped string in the same fence stays
 * `js.string.literal`: the speculative-string rule finds it, and that rule fails the same
 * way wherever it runs.
 */
function asFenceShape(reference: RawReference): RawReference {
  return reference.shape.startsWith('js.import.')
    ? { ...reference, shape: 'astro.import.frontmatter' }
    : reference;
}

/**
 * Re-stamp what the HTML adapter found in the template body.
 *
 * Host wins for the same reason it does in Markdown: a literal path in an Astro body
 * is found by HTML machinery but reached through Astro's own body/fence split, and
 * that split is what fails on its own. CSS from a `<style>` element or a `style` attribute
 * keeps a separate row, because style extraction is a separate mechanism, as it is in HTML.
 */
function asBodyShape(reference: RawReference): RawReference {
  if (reference.shape === 'html.style.element' || reference.shape === 'html.style.attribute') {
    return { ...reference, shape: 'astro.style.element' };
  }
  return { ...reference, shape: 'astro.template.literal' };
}
