/**
 * The Markdown / MDX adapter.
 *
 * Finds `![alt](path)` images, ordinary `[text](path)` links, link reference
 * definitions, and any raw HTML the document contains.
 *
 * Regular expressions are acceptable here — §3.2 allows them for Markdown — but only
 * after the text has been masked. Code fences, inline code spans and HTML comments
 * are blanked out first, because a `![](old.png)` inside a fenced example is
 * documentation, not a reference, and rewriting it would corrupt the prose.
 *
 * Masking replaces those regions with spaces of exactly the same length, so every
 * offset still points at the real file. The raw HTML is then handed to the HTML
 * adapter rather than matched with more regular expressions: Markdown allows any
 * HTML, and `<picture>` blocks with `srcset` turn up in real READMEs.
 */

import { applyEdits } from '../edits.js';
import type { Adapter, RawReference } from '../types.js';
import { htmlAdapter } from './html.js';
import { isExternalUrl, splitPathSuffix, templateExpressionReason } from './reference-path.js';

/**
 * A destination that is not angle-bracketed.
 *
 * Ordinarily it runs to the first space or paren, but a template expression is
 * allowed to contain spaces: `![Logo]({{ site.baseurl }}/logo.png)` is how Jekyll,
 * Hugo and Eleventy all write a path, and stopping at the first space would find
 * nothing at all there. Missing it entirely is the worse failure — the image then
 * looks unreferenced, and a later rewrite breaks the page with nothing reported.
 */
const BARE_DESTINATION = String.raw`(?:\{\{[^}]*\}\}|\{%[^%]*%\}|[^\s()])+`;

/**
 * `![alt](destination "title")`, and the same without the `!` for a plain link.
 *
 * A link to an image file is as real a reference as an embed — following it fetches
 * the file — and the resolver drops anything that is not a tracked asset anyway, so
 * capturing both costs nothing and misses less. The `d` flag gives exact capture
 * offsets, which is what makes this safe to rewrite.
 */
const LINK = new RegExp(
  String.raw`!?\[[^\]]*\]\(\s*(?:<([^>\n]*)>|(${BARE_DESTINATION}))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)`,
  'gd',
);

/** `[label]: destination "title"` — a link reference definition. */
const DEFINITION = new RegExp(
  String.raw`^ {0,3}\[[^\]]+\]:[ \t]*(?:<([^>\n]*)>|(${BARE_DESTINATION}))`,
  'gdm',
);

export const markdownAdapter: Adapter = {
  id: 'markdown',
  extensions: ['.md', '.mdx', '.markdown'],

  findReferences({ file, text }): RawReference[] {
    const masked = maskInactiveRegions(text);
    const references: RawReference[] = [];

    for (const pattern of [LINK, DEFINITION]) {
      collectMatches(pattern, masked, file, references);
    }

    // Markdown permits arbitrary HTML, so the HTML adapter reads the same masked
    // text. Its offsets are absolute, and the masked regions hold no tags.
    references.push(...htmlAdapter.findReferences({ file, text: masked }));

    return references.sort((a, b) => a.start - b.start);
  },

  rewrite({ text, edits }): string {
    return applyEdits(text, edits);
  },
};

function collectMatches(
  pattern: RegExp,
  masked: string,
  file: string,
  references: RawReference[],
): void {
  pattern.lastIndex = 0;

  for (const match of masked.matchAll(pattern)) {
    // Group 1 is an angle-bracketed destination, group 2 a bare one; exactly one
    // participates in any match.
    const range = match.indices?.[1] ?? match.indices?.[2];
    if (range === undefined) continue;

    const [start, end] = range;
    addReference(masked.slice(start, end), start, file, references);
  }
}

function addReference(raw: string, start: number, file: string, references: RawReference[]): void {
  if (raw === '') return;
  if (isExternalUrl(raw, 'md')) return;

  const reason = templateExpressionReason(raw);
  if (reason !== null) {
    // Jekyll, Hugo and Eleventy all build paths in Markdown this way.
    references.push({
      file,
      start,
      end: start + raw.length,
      rawPath: raw,
      kind: 'md',
      ceiling: 'unsafe',
      asserted: true,
      note: reason,
    });
    return;
  }

  const { path, suffix } = splitPathSuffix(raw);
  if (path === '') return;

  references.push({
    file,
    start,
    end: start + path.length,
    rawPath: path,
    kind: 'md',
    ceiling: 'high',
    asserted: true,
    ...(suffix === '' ? {} : { note: `query or fragment preserved: ${suffix}` }),
  });
}

/**
 * Blank out every region where Markdown syntax is not active.
 *
 * Newlines survive so that line-anchored patterns still see the right structure,
 * and every other masked character becomes a space so that offsets are unchanged.
 *
 * Indented (four-space) code blocks are deliberately *not* masked: telling one apart
 * from a continuation line inside a list needs a real block parser, and guessing
 * wrong would blank out a real reference — a false negative, which is the worse
 * failure of the two.
 */
function maskInactiveRegions(text: string): string {
  let masked = maskFencedBlocks(text);
  masked = maskPattern(masked, /<!--[\s\S]*?-->/g);
  masked = maskPattern(masked, /(`+)[\s\S]*?\1/g);
  return masked;
}

function maskFencedBlocks(text: string): string {
  const lines = text.split('\n');
  let fence: string | null = null;

  const maskedLines = lines.map((line) => {
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);

    if (fence === null) {
      if (opening !== null && opening[1] !== undefined) {
        fence = opening[1].charAt(0);
        return blank(line);
      }
      return line;
    }

    // Inside a fence: a closing fence is one of at least three of the same character.
    if (opening !== null && opening[1] !== undefined && opening[1].charAt(0) === fence) {
      fence = null;
    }
    return blank(line);
  });

  return maskedLines.join('\n');
}

function maskPattern(text: string, pattern: RegExp): string {
  return text.replace(pattern, (match) => blank(match));
}

/** Replace everything but newlines with spaces, preserving length exactly. */
function blank(text: string): string {
  return text.replace(/[^\n]/g, ' ');
}
