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
 *
 * An MDX document's top-level `import`/`export` blocks are JavaScript, and they go to
 * the JavaScript adapter the same way (R167) — see `readMdxEsm` for how MDX itself
 * decides where one starts and ends.
 */

import { UpflyError } from '../errors.js';
import { extensionOf } from '../paths.js';
import type { ShapeId } from '../shapes.js';
import type { Adapter, RawReference } from '../types.js';
import { defineAdapter } from './define.js';
import { htmlAdapter } from './html.js';
import { findJavaScriptReferences, javaScriptParseOutcome } from './javascript.js';
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

/**
 * Does this document contain anything parse5 could find a reference in?
 *
 * `<` followed by an ASCII letter is exactly HTML's own tag-open condition, so this is
 * the boundary the parser uses rather than a guess at one. `< img` is text to parse5 and
 * text to this test; `<IMG` is a tag to both.
 */
const MARKUP_OPENER = /<[a-zA-Z]/;

/** `[label]: destination "title"` — a link reference definition. */
const DEFINITION = new RegExp(
  String.raw`^ {0,3}\[[^\]]+\]:[ \t]*(?:<([^>\n]*)>|(${BARE_DESTINATION}))`,
  'gdm',
);

export const markdownAdapter: Adapter = defineAdapter({
  id: 'markdown',
  extensions: ['.md', '.mdx', '.markdown'],

  findReferences({ file, text }): RawReference[] {
    const isMdx = extensionOf(file) === '.mdx';
    const inactive = maskInactiveRegions(text);

    // 🔴 R167 group A: MDX's top-level `import`/`export` lines are JavaScript, and until
    // this they were read by nothing — `import hero from './hero.png'` in a post named an
    // asset the graph never saw, so the asset looked unreferenced. They go to the
    // JavaScript adapter exactly as an Astro fence does, and are then blanked out of what
    // the Markdown and HTML readers see, so one line is never read by two languages.
    const esm = isMdx ? readMdxEsm(file, text, inactive) : null;
    const masked = esm === null ? inactive : blankRanges(inactive, esm.blocks);
    const references: RawReference[] = [...(esm?.references ?? [])];

    // A use site and a definition are different rows: `![alt](x.png)` carries the path
    // where it is used, `[label]: x.png` carries it somewhere else entirely, and the
    // second is what makes `md.image.reference-style` a row nothing can fill.
    collectMatches(LINK, masked, file, references, 'md.image');
    collectMatches(DEFINITION, masked, file, references, 'md.reference-definition');

    // Markdown permits arbitrary HTML, so the HTML adapter reads the same masked
    // text. Its offsets are absolute, and the masked regions hold no tags.
    //
    // 🔴 **R124: ~20% of the graph build was parse5 reading markdown for HTML that was
    // not there.** Every `.md` and `.mdx` paid a full parse5 parse, and parse5 is 73–78%
    // of this adapter's cost on all three trees measured. A document with no element in
    // it cannot yield an attribute reference, because every path the HTML adapter can
    // find lives in a tag — `img/source/video/audio/embed/input/track` `src`, `link`
    // `href`, or a `style` attribute, all of which require one.
    //
    // ⚠️ **The test is on the MASKED text, which is the whole subtlety.** Real markdown
    // keeps its tags inside fenced code blocks — astro-docs holds 2,604 documents at 19.6
    // tags each and **not one** where dropping this pass loses a reference — and masking
    // blanks a fence before parse5 sees it. Testing the raw text would skip almost
    // nothing on real repositories; testing the masked text skips exactly the documents
    // where the pass had nothing to find.
    //
    // ⚠️ **`<` followed by a letter, deliberately coarser than the question being asked.**
    // It matches `<span>` and `<!-- -->` alike and every unknown component, so it
    // over-approximates: it can only skip a document with no element-like construct at
    // all. A tighter test — looking for `img` or `src` — would be the kind of narrowing
    // that turns a safe optimisation into a silent loss.
    if (MARKUP_OPENER.test(masked)) {
      // R20: it can throw — a `<style>` block whose CSS will not parse reaches the CSS
      // adapter through it — and everything collected above is correct regardless. The
      // failure still propagates, so `scan` still reports the file as unparseable and
      // rule 9 holds; what rides along is the references that were already found.
      try {
        references.push(
          ...htmlAdapter
            .findReferences({ file, text: masked })
            .map((reference) => asMarkdownShape(reference, isMdx)),
        );
      } catch (error) {
        throw withPartial(error, references);
      }
    }

    // An ESM block MDX itself would refuse is reported only now, so every reference the
    // rest of the document holds rides along with it (R20) rather than being lost to it.
    if (esm?.failure) throw withPartial(esm.failure, references);

    return references.sort((a, b) => a.start - b.start);
  },
});

/**
 * Re-throw an adapter failure carrying everything already found beside it (R20).
 *
 * ⚠️ **The diagnostic is carried too.** The version of this inlined above dropped it, so
 * PostCSS's own text for a `<style>` block inside Markdown never reached the diagnostic
 * channel that R60 built for exactly that text.
 */
function withPartial(error: unknown, references: readonly RawReference[]): unknown {
  if (!(error instanceof UpflyError)) return error;
  return new UpflyError(
    error.code,
    error.message,
    [...references, ...(error.partial as RawReference[])],
    error.diagnostic,
  );
}

/**
 * YAML frontmatter at the very start of the document, which is not Markdown and not ESM.
 *
 * The same shape `astro.ts` anchors its fence with: offset 0, and a closing `---` alone
 * on its line. Kept separate rather than shared because the two formats agree on it by
 * convention, not by specification, and one changing should not silently move the other.
 */
const FRONTMATTER = /^---[^\S\n]*\r?\n[\s\S]*?\r?\n---[^\S\n]*(?:\r?\n|$)/;

/** MDX's own opener: `import` or `export` at column 1, followed by exactly one space. */
const ESM_OPENER = /^(?:import|export) /;
const ESM_ANYWHERE = /^(?:import|export) /m;

/** A blank line as MDX means it: nothing but spaces and tabs before the line ending. */
const BLANK_LINE = /^[ \t]*\r?$/;

interface Line {
  readonly start: number;
  /** Exclusive, and before the `\n`. */
  readonly end: number;
}

interface MdxEsm {
  /** Where each block sits, so the Markdown and HTML readers can be kept out of it. */
  readonly blocks: readonly Line[];
  readonly references: readonly RawReference[];
  /** The first block MDX itself could not parse, deferred so it cannot take the rest. */
  readonly failure: unknown;
}

/**
 * Every top-level `import`/`export` block of an MDX document, read as JavaScript.
 *
 * 🔴 **THE BLOCK BOUNDARIES ARE MDX's, READ FROM ITS SOURCE — NOT GUESSED.** From
 * `micromark-extension-mdxjs-esm`:
 *
 * - **`return self.interrupt ? nok : start`** — ESM can never interrupt a paragraph. A
 *   prose line that happens to begin *"export and option."* is paragraph text, and
 *   shadcn-ui's docs hold three exactly like that; reading them as code made all three
 *   parse failures on the first measurement. So an opener counts only at the start of
 *   the body or straight after a blank line — which, on 2,905 real MDX files, is every
 *   one of the 1,665 blocks that parse (1,193 directly under the frontmatter).
 * - **`if (self.now().column > 1) return nok`** — column 1 only, so never inside a list
 *   or a block quote.
 * - **the keyword is followed by exactly one space.**
 * - **a block ends at a blank line, unless the code so far is an unfinished prefix**,
 *   in which case MDX swallows the blank line and continues. `javaScriptParseOutcome`
 *   is that test.
 *
 * ⚠️ **The opener is found in the MASKED text and the block is read from the SOURCE.**
 * Masked, because an `import` inside a code fence is an example and must stay inert —
 * the fence is blank there, so it can never open a block. Source, because the mask also
 * blanks backtick spans, and a template literal inside an `export` is code, not a span.
 *
 * ⚠️ **Opening straight after a heading or a JSX line is not recognised**, although MDX
 * would accept it: telling those from a paragraph line needs a block parser. It was
 * measured before it was accepted — **zero** such blocks in the 2,905 files — and the
 * cost of the gap is today's behaviour, not a new one.
 */
function readMdxEsm(file: string, text: string, masked: string): MdxEsm | null {
  // One regex over the document before any per-line work: most `.mdx` in the bench tree,
  // and plenty in real repositories, have no ESM at all and should pay nothing for it.
  if (!ESM_ANYWHERE.test(masked)) return null;
  const lines = linesOf(text);
  const bodyStart = FRONTMATTER.exec(text)?.[0].length ?? 0;
  const isBlank = (source: string, line: Line | undefined) =>
    line !== undefined && BLANK_LINE.test(source.slice(line.start, line.end));

  const blocks: Line[] = [];
  const references: RawReference[] = [];
  let failure: unknown = null;

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as Line;
    const opens =
      line.start >= bodyStart &&
      ESM_OPENER.test(masked.slice(line.start, line.end)) &&
      (line.start === bodyStart || isBlank(masked, lines[index - 1]));
    if (!opens) {
      index += 1;
      continue;
    }

    const read = readEsmBlock(file, text, lines, index, isBlank);
    blocks.push({ start: line.start, end: (lines[read.last] as Line).end });
    references.push(...read.references);
    if (read.failure !== null && failure === null) failure = read.failure;
    index = read.last + 1;
  }

  return blocks.length === 0 ? null : { blocks, references, failure };
}

/**
 * One ESM block, from its opener to its end as MDX would find it.
 *
 * Handed to the JavaScript adapter as a full-length copy with everything before the
 * block blanked — the Astro adapter's device — so every offset it returns is already an
 * offset into the `.mdx` file, and a parse error names the file's own line.
 */
function readEsmBlock(
  file: string,
  text: string,
  lines: readonly Line[],
  first: number,
  isBlank: (source: string, line: Line | undefined) => boolean,
): { last: number; references: RawReference[]; failure: unknown } {
  const start = (lines[first] as Line).start;
  const chunkEnd = (from: number) => {
    let last = from;
    while (last + 1 < lines.length && !isBlank(text, lines[last + 1])) last += 1;
    return last;
  };

  const firstChunk = chunkEnd(first);
  let last = firstChunk;
  for (;;) {
    const end = (lines[last] as Line).end;
    try {
      const found = findJavaScriptReferences({
        file,
        text: blank(text.slice(0, start)) + text.slice(start, end),
        // MDX parses its ESM with acorn and acorn-jsx: JavaScript with JSX, never TypeScript.
        extension: '.jsx',
      });
      return { last, references: found.map(asEsmShape), failure: null };
    } catch (error) {
      // Swallow the blank line only where MDX would: the code stopped early.
      let next = last + 1;
      while (next < lines.length && isBlank(text, lines[next])) next += 1;
      const unfinished = javaScriptParseOutcome(text.slice(start, end), '.jsx') === 'incomplete';
      if (!unfinished || next >= lines.length) {
        // MDX would refuse this document here. The block is still kept away from the
        // Markdown readers — it is code, however broken — and the failure is reported.
        return { last: firstChunk, references: [], failure: error };
      }
      last = chunkEnd(next);
    }
  }
}

/**
 * Re-stamp what the JavaScript adapter found in an ESM block.
 *
 * The same selection the Astro fence makes, for the same reason: what would take an
 * `import` here out is MDX's block extraction, which no `.js` file exercises, so it is
 * MDX's row. A path-shaped string in an `export const` stays `js.string.literal` — the
 * speculative-string rule finds it, and that rule fails identically wherever it runs.
 */
function asEsmShape(reference: RawReference): RawReference {
  return reference.shape.startsWith('js.import.')
    ? { ...reference, shape: 'mdx.import' }
    : reference;
}

function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (;;) {
    const newline = text.indexOf('\n', start);
    if (newline === -1) {
      lines.push({ start, end: text.length });
      return lines;
    }
    lines.push({ start, end: newline });
    start = newline + 1;
  }
}

/** Blank each range, keeping every offset and every newline exactly where it was. */
function blankRanges(text: string, ranges: readonly Line[]): string {
  let out = '';
  let cursor = 0;
  for (const range of ranges) {
    out += text.slice(cursor, range.start) + blank(text.slice(range.start, range.end));
    cursor = range.end;
  }
  return out + text.slice(cursor);
}

/**
 * Re-stamp a reference the HTML adapter found inside Markdown.
 *
 * 🔴 **Host wins here, and the ladder says why.** What would take these out is not
 * `<img src>` parsing — that is the HTML adapter's, tested by its own rows — it is
 * Markdown's decision to hand raw HTML over at all, plus the masking that decides
 * which regions are live. Those fail together and separately from HTML, so they are
 * Markdown's rows.
 *
 * ⚠️ The distinction the tree draws is between *markup* and a *style attribute*, so a
 * `<style>` element inside Markdown maps to the attribute row rather than inventing a
 * third. Markdown holds no `<style>` elements in the tree and none has been seen in a
 * real repository; if one turns up it is a §8.5 growth item, not a silent mismatch.
 */
function asMarkdownShape(reference: RawReference, isMdx: boolean): RawReference {
  if (reference.shape === 'html.style.attribute' || reference.shape === 'html.style.element') {
    return { ...reference, shape: 'md.style-attribute' };
  }
  // MDX's components are JSX, not raw HTML, even though the same scanner finds them:
  // what would take them out is MDX's own handling, and `.md` has no JSX to lose.
  return { ...reference, shape: isMdx ? 'mdx.jsx' : 'md.raw-html' };
}

function collectMatches(
  pattern: RegExp,
  masked: string,
  file: string,
  references: RawReference[],
  shape: ShapeId,
): void {
  pattern.lastIndex = 0;

  for (const match of masked.matchAll(pattern)) {
    // Group 1 is an angle-bracketed destination, group 2 a bare one; exactly one
    // participates in any match.
    const range = match.indices?.[1] ?? match.indices?.[2];
    if (range === undefined) continue;

    const [start, end] = range;
    addReference(masked.slice(start, end), start, file, references, shape);
  }
}

function addReference(
  raw: string,
  start: number,
  file: string,
  references: RawReference[],
  shape: ShapeId,
): void {
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
      shape,
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
    shape,
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
 * The returned string has exactly the same length as the input, so an offset into
 * one indexes the other — which is what makes it safe to search the masked text and
 * report positions in the original.
 *
 * Indented (four-space) code blocks are deliberately *not* masked: telling one apart
 * from a continuation line inside a list needs a real block parser, and guessing
 * wrong would blank out a real reference — a false negative, which is the worse
 * failure of the two.
 *
 * ⚠️ **Exported because a masker nobody can reach is a bug generator (R34).** Anything
 * that searches Markdown for a token has to mask first: an `import` or an `<img src>`
 * inside a ``` fence is documentation *about* code, not code. While this was
 * module-private, every consumer either reimplemented the test or skipped it, and
 * skipping it has now produced the same defect three times — in `bench/`'s triage,
 * where a proxy rule mis-explained 5 of 124 hits, and in a Phase 2 probe that counted
 * 25 alias-shaped references where there were 11, the 14 extras being fenced examples
 * naming files that do not exist in the repository. **Call this instead of writing the
 * test again.**
 */
export function maskInactiveRegions(text: string): string {
  let masked = maskFencedBlocks(text);
  masked = maskPattern(masked, /<!--[\s\S]*?-->/g);
  masked = maskPattern(masked, /(`+)[\s\S]*?\1/g);
  masked = maskUnclosedRawText(masked);
  return masked;
}

/**
 * HTML's raw-text elements, which consume everything until their closing tag.
 *
 * `<plaintext>` and `<xmp>` are obsolete and never close at all, which is exactly
 * why they belong here: parse5 implements the real algorithm, not the polite subset.
 */
const RAW_TEXT_ELEMENTS = ['style', 'script', 'textarea', 'title', 'plaintext', 'xmp'] as const;

/**
 * Blank a raw-text open tag that never closes.
 *
 * Markdown permits arbitrary HTML, so this adapter hands its text to the HTML
 * adapter — and parse5 is a real HTML parser, which means `<script>` opens a
 * **raw-text element** wherever it appears. Prose that merely *mentions* one, as
 * `shadcn-ui/skills/migrate-radix-to-base/SKILL.md:67` does with *"retargeting onto a
 * base-`<style>` variant"*, therefore swallows the entire rest of the document.
 *
 * Every layer is individually right. The masker correctly leaves prose alone;
 * Markdown correctly permits raw HTML; parse5 correctly implements HTML. The
 * **composition** is what is wrong, and it cost two things:
 *
 * - `<style>` hands the swallowed remainder to the CSS parser, which throws, and
 *   every reference collected so far goes with it;
 * - the other five swallow **silently**, so a raw `<img src>` later in the document
 *   is dropped with no error and nothing in the report. A silent skip is a P0 under
 *   rule 9, and that one is the more serious of the two.
 *
 * An open tag with no matching close cannot be an element the author meant — and
 * CommonMark agrees: a raw-text *block* has to begin the line, while one mentioned
 * mid-sentence is inline HTML. So it is blanked with spaces of identical length, the
 * same device the fences and code spans use, and every offset after it stays exact.
 */
function maskUnclosedRawText(text: string): string {
  let masked = text;

  for (const element of RAW_TEXT_ELEMENTS) {
    const open = new RegExp(`<${element}(?=[\\s/>])[^>]*>`, 'gi');
    const close = new RegExp(`</${element}\\s*>`, 'i');

    let match = open.exec(masked);
    while (match !== null) {
      const after = masked.slice(match.index + match[0].length);
      if (!close.test(after)) {
        masked =
          masked.slice(0, match.index) +
          blank(match[0]) +
          masked.slice(match.index + match[0].length);
      }
      match = open.exec(masked);
    }
  }

  return masked;
}

/**
 * Blank every fenced code block.
 *
 * ⚠️ **Two CommonMark rules were missing, and getting them wrong inverts the mask
 * from that point to the end of the file** — so a fenced example becomes a live
 * reference *and* a real reference two paragraphs later is blanked away. A false
 * positive and a false negative from one defect, with no error either way.
 *
 * Found by chasing why `astro-docs`'s unsafe bucket was full of CSP headers: those
 * headers sit inside a ` ```html ` block, and the mask had come out of step 600
 * lines earlier. The report noise was the symptom; this is the cause.
 *
 * - **A closing fence may not carry an info string.** ` ```ts ` can only ever open a
 *   block. Treating it as a close is what desynchronised `api-reference.mdx`, which
 *   opens fences with ` ```astro ` and ` ```ts title="…" ` throughout.
 * - **A closing fence must be at least as long as the opening one**, which is how a
 *   ` ```` ` block quotes a ` ``` ` block — exactly what documentation about Markdown
 *   does constantly.
 *
 * The character rule was already right: a `~~~` block is not closed by ` ``` `.
 */
function maskFencedBlocks(text: string): string {
  const lines = text.split('\n');
  let fence: { char: string; length: number } | null = null;

  const maskedLines = lines.map((line) => {
    const opening = /^ {0,3}((`{3,})|(~{3,}))([^\n]*)$/.exec(line);
    const marker = opening?.[1];
    const info = opening?.[4] ?? '';

    if (fence === null) {
      if (marker !== undefined) {
        fence = { char: marker.charAt(0), length: marker.length };
        return blank(line);
      }
      return line;
    }

    // A closing fence: same character, at least as long, and no info string. A
    // backtick fence's info string may not contain a backtick either, so a line of
    // pure backticks longer than the opener still closes.
    if (
      marker !== undefined &&
      marker.charAt(0) === fence.char &&
      marker.length >= fence.length &&
      info.trim() === ''
    ) {
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
