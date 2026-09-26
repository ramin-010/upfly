/**
 * The Markdown / MDX adapter.
 *
 * Finds `![alt](path)` images, ordinary `[text](path)` links, link reference definitions,
 * and any raw HTML the document contains. Its regular expressions run only over masked
 * text, where code fences, code spans and HTML comments are blanked to spaces of the same
 * length. Raw HTML goes to the HTML adapter, and an MDX document's top-level
 * `import`/`export` blocks to the JavaScript adapter (`readMdxEsm` finds where MDX starts
 * and ends one). See "The six that exist" in ARCHITECTURE.md.
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
 * nothing at all there. Missing it entirely is the worse failure: the image then
 * looks unreferenced, and a later rewrite breaks the page with nothing reported.
 */
const BARE_DESTINATION = String.raw`(?:\{\{[^}]*\}\}|\{%[^%]*%\}|[^\s()])+`;

/**
 * `![alt](destination "title")`, and the same without the `!` for a plain link.
 *
 * A link to an image file is as real a reference as an embed (following it fetches
 * the file), and the resolver drops anything that is not a tracked asset anyway, so
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
 * `<` followed by an ASCII letter is what starts a tag in the HTML spec's tag open state,
 * so this is the boundary the parser uses rather than a guess at one. `< img` is text to
 * parse5 and text to this test; `<IMG` is a tag to both.
 */
const MARKUP_OPENER = /<[a-zA-Z]/;

/** `[label]: destination "title"`, a CommonMark link reference definition. */
const DEFINITION = new RegExp(
  String.raw`^ {0,3}\[[^\]]+\]:[ \t]*(?:<([^>\n]*)>|(${BARE_DESTINATION}))`,
  'gdm',
);

export const markdownAdapter: Adapter = defineAdapter({
  id: 'markdown',
  extensions: ['.md', '.mdx', '.markdown'],

  findReferences({ file, text }): RawReference[] {
    const isMdx = extensionOf(file) === '.mdx';
    const inactive = maskInactiveRegions(text, { indentedCode: !isMdx });

    // MDX's top-level `import`/`export` blocks are JavaScript, and name assets
    // (`import hero from './hero.png'`). They go to the JavaScript adapter as an Astro
    // fence does, and are then blanked from what the Markdown and HTML readers see, so no
    // line is read by two languages.
    const esm = isMdx ? readMdxEsm(file, text, inactive) : null;
    const masked = esm === null ? inactive : blankRanges(inactive, esm.blocks);
    const references: RawReference[] = [...(esm?.references ?? [])];

    // A use site and a definition are different shapes. In `![alt][label]` the path lives
    // in the `[label]: x.png` definition, reported once as `md.reference-definition`, so
    // the use site itself (`md.image.reference-style`) emits nothing.
    collectMatches(LINK, masked, file, references, 'md.image');
    collectMatches(DEFINITION, masked, file, references, 'md.reference-definition');

    // Markdown permits arbitrary HTML, so the HTML adapter reads the same masked
    // text. Its offsets are absolute, and the masked regions hold no tags.
    //
    // parse5 is most of this adapter's cost, and every reference the HTML adapter finds
    // sits in a tag, so the pass is skipped when the masked text holds no tag opener.
    // Testing the masked text is what makes this pay: Markdown keeps most of its tags in
    // code fences, which masking has already blanked. The test is coarser than the question
    // on purpose: it matches any tag, known or not, and narrowing it to `img` or `src`
    // would risk skipping a real reference.
    if (MARKUP_OPENER.test(masked)) {
      // A `<style>` block whose CSS will not parse makes this throw. Everything collected
      // above is still correct, so it rides along with the failure, and `scan` still
      // reports the file as unparseable.
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
    // rest of the document holds rides along with it rather than being lost to it.
    if (esm?.failure) throw withPartial(esm.failure, references);

    return references.sort((a, b) => a.start - b.start);
  },
});

/**
 * An adapter failure rebuilt to carry everything already found beside it, for the caller
 * to throw. The diagnostic is kept, so the parser's own text still reaches the diagnostic
 * channel.
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
 * The boundaries are MDX's own, from `micromark-extension-mdxjs-esm`. An opener is `import`
 * or `export` and one space at column 1 (so never in a list or block quote), at the start
 * of the body or after a blank line: ESM cannot interrupt a paragraph, so a prose line that
 * begins "export and option." stays text. A block ends at a blank line unless the code so
 * far is an unfinished prefix (`javaScriptParseOutcome`), in which case MDX reads on. An
 * opener straight after a heading or a JSX line, which MDX accepts, is not recognised here,
 * because telling those from a paragraph line needs a block parser.
 *
 * Openers are found in the masked text, so an `import` in a code fence stays inert; blocks
 * are read from the source, where a template literal is not blanked as a code span.
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
 * Handed to the JavaScript adapter as the file up to the block's end, with everything
 * before the block blanked (the Astro adapter's device), so every offset it returns is
 * already an offset into the `.mdx` file, and a parse error names the file's own line.
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
        // Markdown readers (it is code, however broken), and the failure is reported.
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
 * MDX's row. A path-shaped string in an `export const` stays `js.string.literal`: the
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
 * The host decides the shape. What would break these references is Markdown handing its
 * raw HTML over and masking the inactive regions, not `<img src>` parsing, which the HTML
 * adapter's own shapes cover. CSS from a `<style>` element maps to `md.style-attribute`
 * too: no Markdown `<style>` element has turned up in the coverage tree or a validation
 * repository to fill a row of its own.
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
 * Blank out every region of Markdown text where Markdown syntax is not active, so a search
 * for references cannot match inside code.
 *
 * Fenced code, code spans, HTML comments and the opening tag of a raw-text element that is
 * never closed become spaces. Newlines stay, so the result has the input's length and line
 * structure, and an offset into one indexes the other. Indented code blocks are blanked
 * only with `indentedCode: true`, and only where they are certain; MDX has none (MDX 2
 * turned them off, because JSX is indented). Mask before searching Markdown for any
 * token: an `import` or `<img src>` inside a fence is documentation, not code.
 */
export function maskInactiveRegions(
  text: string,
  options: {
    /** `true` for CommonMark (`.md`, `.markdown`); MDX has no indented code blocks. */
    readonly indentedCode?: boolean;
  } = {},
): string {
  const fenced = maskFencedBlocks(text);
  let masked = maskPattern(fenced, /<!--[\s\S]*?-->/g);
  // Before the code-span pass, not after it: a backtick inside an indented block is a
  // literal character, and left in place it can pair with one in the prose below and
  // blank a real reference between them.
  if (options.indentedCode === true) masked = maskIndentedCodeBlocks(masked, text, fenced);
  masked = maskPattern(masked, /(`+)[\s\S]*?\1/g);
  masked = maskUnclosedRawText(masked);
  return masked;
}

/** A list item's marker, wherever it sits: bullet or ordered, and what follows it. */
const LIST_MARKER = /^([ \t]*)([-+*]|\d{1,9}[.)])([ \t]+|$)/;

/** `***`, `- - -` or `___`: a thematic break, which is never a list item. */
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

/** An ATX heading: a whole block on one line. */
const ATX_HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;

/**
 * CommonMark's HTML block type 1, which a blank line does not end: its content is HTML
 * until the closing tag, however it is indented.
 */
const RAW_HTML_BLOCK = /^ {0,3}<(script|pre|style|textarea)(?=[\s>]|$)/i;

/**
 * Blank every indented code block, and nothing that only looks like one.
 *
 * An indented block is code shown, not run, like a fence. But blanking a line that is not
 * code loses a real reference, so wherever CommonMark could read it otherwise, it stays live:
 * - in a list item, even as nested code: telling the two apart needs column arithmetic,
 *   and a wrong guess blanks a real image;
 * - after a paragraph line, which it continues. Code needs a blank line, an ATX heading, a
 *   thematic break, a fence or more code before it; a `===` underline is not recognised;
 * - in a `<pre>`, `<script>`, `<style>` or `<textarea>` block, which a blank line does not end.
 *
 * Structure comes from `source`, never the mask: a masked HTML comment is not a blank line,
 * and reading it as one would end an HTML block early and blank the live lines after it.
 */
function maskIndentedCodeBlocks(masked: string, source: string, fenced: string): string {
  const sourceLines = source.split('\n');
  const fencedLines = fenced.split('\n');
  const state: BlockState = { listContent: null, rawHtmlEnd: null, previous: 'blank' };

  return masked
    .split('\n')
    .map((line, index) =>
      isIndentedCode(state, sourceLines[index] ?? '', fencedLines[index] ?? '')
        ? blank(line)
        : line,
    )
    .join('\n');
}

/** What the lines so far leave open, as far as indented code is concerned. */
interface BlockState {
  /** The outermost open list item's content column, or null when no list is open. */
  listContent: number | null;
  /** The closing tag of an open `<pre>`-type HTML block, which a blank line does not end. */
  rawHtmlEnd: RegExp | null;
  previous: 'blank' | 'code' | 'block' | 'text';
}

/** Advance `state` past one source line, and say whether that line is indented code. */
function isIndentedCode(state: BlockState, original: string, fenced: string): boolean {
  const isBlank = BLANK_LINE.test(original);
  // A fence's own lines are blank already, and the block they form is complete once it
  // closes, so what follows the closing fence starts afresh.
  if (!isBlank && BLANK_LINE.test(fenced)) {
    state.previous = 'block';
    return false;
  }
  if (state.rawHtmlEnd !== null) {
    if (state.rawHtmlEnd.test(original)) state.rawHtmlEnd = null;
    state.previous = 'text';
    return false;
  }
  if (isBlank) {
    state.previous = 'blank';
    return false;
  }

  const indent = columnsOf(original);
  trackList(state, original, indent);
  if (state.listContent === null && indent >= 4 && state.previous !== 'text') {
    state.previous = 'code';
    return true;
  }

  state.rawHtmlEnd = rawHtmlBlockEnd(original);
  state.previous = ATX_HEADING.test(original) || THEMATIC_BREAK.test(original) ? 'block' : 'text';
  return false;
}

/**
 * Open a list at a marker, and close it at the first line after a blank that is indented
 * less than its outermost item's content, never at a line carrying a paragraph on.
 */
function trackList(state: BlockState, original: string, indent: number): void {
  const marker = THEMATIC_BREAK.test(original) ? null : LIST_MARKER.exec(original);
  const open = state.listContent;
  if (open !== null && marker === null && state.previous === 'blank' && indent < open) {
    state.listContent = null;
  }
  if (marker !== null && (open === null ? indent <= 3 : indent < open)) {
    state.listContent = contentColumnOf(marker);
  }
}

/** The closing tag a `<pre>`-type HTML block waits for, when this line opens one. */
function rawHtmlBlockEnd(original: string): RegExp | null {
  const opener = RAW_HTML_BLOCK.exec(original);
  if (opener === null) return null;
  const close = new RegExp(`</${opener[1]}\\s*>`, 'i');
  return close.test(original) ? null : close;
}

/** Leading whitespace in columns, a tab advancing to the next multiple of four. */
function columnsOf(line: string): number {
  let column = 0;
  for (const character of line) {
    if (character === ' ') column += 1;
    else if (character === '\t') column += 4 - (column % 4);
    else break;
  }
  return column;
}

/**
 * Where a list item's content starts. One to four columns of space after the marker
 * are part of it; five or more mean the item opens with indented code, and then, as
 * for an empty item, the content column is one past the marker.
 */
function contentColumnOf(marker: RegExpExecArray): number {
  const [, leading = '', symbol = '', spacing = ''] = marker;
  const markerEnd = columnsOf(leading) + symbol.length;
  const gap = columnsOf(`${' '.repeat(markerEnd)}${spacing}`) - markerEnd;
  return gap >= 1 && gap <= 4 ? markerEnd + gap : markerEnd + 1;
}

/**
 * HTML's raw-text elements, which consume everything until their closing tag.
 *
 * The obsolete `<xmp>` and `<plaintext>` belong here too (`<plaintext>` never closes at
 * all): parse5 implements the whole parsing algorithm, not the polite subset.
 */
const RAW_TEXT_ELEMENTS = ['style', 'script', 'textarea', 'title', 'plaintext', 'xmp'] as const;

/**
 * Blank a raw-text open tag that never closes.
 *
 * parse5 is a real HTML parser, so a `<script>` or `<style>` opens a raw-text element
 * wherever it appears, and prose that merely mentions one ("a base-`<style>` variant")
 * swallows the rest of the document. For `<style>` the swallowed text reaches the CSS
 * parser, which throws; the others swallow silently, so a later `<img src>` is dropped
 * with nothing in the report. An open tag with no matching close is not an element the
 * author meant, and mid-sentence CommonMark agrees: there it is inline HTML, and the text
 * after it is still Markdown. So it is blanked with spaces of the same length.
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
 * The closing rules below are CommonMark's, and getting one wrong puts the mask out of
 * step for the rest of the file: a fenced example turns live and a real reference after
 * it is blanked, with no error either way. ` ```ts ` can only open a block, and a
 * ` ```` ` block can quote a ` ``` ` one, as documentation about Markdown often does.
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
