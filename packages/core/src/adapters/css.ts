/**
 * The CSS / SCSS / Less adapter.
 *
 * Finds `url()` and `image-set()` references. Two parsers do the work, and using
 * them rather than a regex is the whole point: PostCSS tells us which byte ranges
 * are real declarations (so a `url()` inside a comment or a selector is never
 * mistaken for one), and `postcss-value-parser` breaks a declaration value into
 * typed tokens with source offsets, so quoting, nesting and escapes are somebody
 * else's solved problem.
 *
 * Like every adapter this one is pure: it takes text and returns data. It never
 * resolves a path and never asks whether a file exists.
 */

import postcss, { type Declaration, type Root } from 'postcss';
import lessParser from 'postcss-less';
import scssParser from 'postcss-scss';
import valueParser, { type Node as ValueNode } from 'postcss-value-parser';
import { UpflyError } from '../errors.js';
import { extensionOf } from '../paths.js';
import type { ShapeId } from '../shapes.js';
import type { Adapter, RawReference } from '../types.js';
import { defineAdapter } from './define.js';
import { parseFailure } from './parse-failure.js';
import { isExternalUrl, splitPathSuffix } from './reference-path.js';

/**
 * Dialect parsers, by extension.
 *
 * SCSS and Less need their own parser mainly for `//` line comments, which the
 * plain CSS parser does not understand — and a `// url(old.png)` that we mistook
 * for a live reference would be rewritten, corrupting a comment. `.sass`, the
 * indentation-based syntax, is deliberately absent: the only parser for it is
 * unmaintained, and claiming support we cannot test is worse than not claiming it.
 */
const PARSERS: ReadonlyMap<string, (css: string) => Root> = new Map([
  ['.css', (css: string) => postcss.parse(css, { from: undefined })],
  ['.scss', (css: string) => scssParser.parse(css, { from: undefined })],
  ['.less', (css: string) => lessParser.parse(css, { from: undefined })],
]);

/** Function names whose direct string arguments are themselves image paths. */
function isImageSet(functionName: string): boolean {
  // `image-set`, plus the vendor-prefixed `-webkit-image-set` and `-ms-image-set`.
  return functionName === 'image-set' || functionName.endsWith('-image-set');
}

/**
 * Find CSS references in a run of stylesheet text.
 *
 * Exported because CSS turns up inside other formats: an HTML `<style>` element and
 * a `style=""` attribute are both CSS, and they deserve the same comment-aware,
 * interpolation-aware treatment as a `.css` file rather than a second, weaker
 * implementation in the HTML adapter. `baseOffset` is where this text begins inside
 * the file that contains it, so the offsets that come back point into that file.
 *
 * PostCSS parses a bare declaration list (`background: url(a.png)`) as happily as a
 * full stylesheet, so a `style` attribute needs no wrapping.
 */
export function findCssReferences(input: {
  readonly file: string;
  readonly text: string;
  /** Absolute offset of `text[0]` within the file. Defaults to 0. */
  readonly baseOffset?: number;
  /** Dialect to parse as. Defaults to plain CSS. */
  readonly extension?: string;
  /**
   * The shape to stamp on a plain `url()` when this CSS is EMBEDDED in something else
   * — an HTML `<style>` element, a `style=""` attribute, an `.astro` style block, a
   * CSS-in-JS template. Omitted for a real stylesheet, where the dialect decides.
   *
   * 🔴 **It is a default, not an override.** A `url()` inside `<style>` is
   * `html.style.element` because what would take it out is HTML's *extraction*; but an
   * `image-set()` or an `@font-face` in the same block keeps its own `css.*` shape,
   * because those break identically in every host. That is the ladder in `shapes.ts`,
   * and getting it backwards would hide a break in image-set parsing behind whichever
   * host it happened to be embedded in.
   */
  readonly hostShape?: ShapeId;
}): RawReference[] {
  const { file, text, baseOffset = 0, extension = '.css', hostShape } = input;

  const parse = PARSERS.get(extension);
  if (parse === undefined) {
    throw new UpflyError(
      'ADAPTER_PARSE_FAILED',
      `The css adapter does not handle ${extension || 'files without an extension'} (${file}).`,
    );
  }

  let root: Root;
  try {
    root = parse(text);
  } catch (error) {
    // A malformed stylesheet is the caller's problem to report, not ours to
    // swallow: returning [] here would silently claim the file has no references.
    //
    // No `${file}`: `scan` records the path in its own field and the report
    // prints it immediately before this message, so interpolating it here put the
    // filename on every line twice. R20's scrub in `unscannedFile` stays as the
    // net for community adapters that do interpolate one.
    //
    // R60: the sentence is ours and carries PostCSS's position; PostCSS's wording
    // goes to the diagnostic channel and never to the report.
    const failure = parseFailure({
      error,
      // What we tried to read it as, which is the dialect the extension claimed.
      dialect: extension.replace(/^\./, '') || 'css',
      position: 'postcss',
    });
    throw new UpflyError('ADAPTER_PARSE_FAILED', failure.message, [], failure.diagnostic);
  }

  const references: RawReference[] = [];
  root.walkDecls((declaration) => {
    collectFromDeclaration(declaration, { file, baseOffset, extension, hostShape, references });
  });

  // Document order already, but sorting makes determinism a property of the code
  // rather than of PostCSS's traversal order.
  return references.sort((a, b) => a.start - b.start);
}

export const cssAdapter: Adapter = defineAdapter({
  id: 'css',
  extensions: ['.css', '.scss', '.less'],

  findReferences({ file, text }): RawReference[] {
    return findCssReferences({ file, text, extension: extensionOf(file) });
  },
});

/**
 * PostCSS keeps the author's original text in `raws.<field>.raw` whenever it differs
 * from the cleaned-up value — a value containing a comment, for instance. We always
 * want the original, because its length is what the source offsets are made of.
 */
function rawTextOf(raw: unknown, fallback: string): string {
  if (typeof raw === 'object' && raw !== null && 'raw' in raw) {
    const { raw: original } = raw as { raw: unknown };
    if (typeof original === 'string') return original;
  }
  return fallback;
}

/**
 * What every emission in one stylesheet shares.
 *
 * Collected into an object rather than threaded as five positional arguments: the
 * shape needs the dialect, the host and the declaration all at once, and a chain of
 * `(file, baseOffset, extension, hostShape, references)` is where an argument gets
 * passed in the wrong slot.
 */
interface CssRun {
  readonly file: string;
  readonly baseOffset: number;
  readonly extension: string;
  readonly hostShape: ShapeId | undefined;
  readonly references: RawReference[];
}

/** What one declaration adds: the two things that decide a shape on their own. */
interface DeclarationContext {
  /** `--brand-image` means the url is reached through a custom property. */
  readonly property: string;
  /** `@font-face` bodies hold fonts, which are real files the engine never indexes. */
  readonly inFontFace: boolean;
}

function collectFromDeclaration(declaration: Declaration, run: CssRun): void {
  const { file } = run;
  const declarationStart = declaration.source?.start?.offset;
  if (declarationStart === undefined) {
    throw new UpflyError(
      'ADAPTER_PARSE_FAILED',
      `PostCSS returned a declaration without a source position in ${file}.`,
    );
  }

  // A declaration is laid out as `prop` + `between` + `value`, where `between` is
  // the colon and any surrounding whitespace or comments. Adding those lengths to
  // the declaration's own offset lands exactly on the first character of the value.
  const property = rawTextOf(declaration.raws.prop, declaration.prop);
  const between = declaration.raws.between ?? ':';
  const value = rawTextOf(declaration.raws.value, declaration.value);
  const valueStart = run.baseOffset + declarationStart + property.length + between.length;

  const parent = declaration.parent;
  const declarationContext: DeclarationContext = {
    property,
    inFontFace:
      parent !== undefined &&
      parent.type === 'atrule' &&
      (parent as { name?: string }).name?.toLowerCase() === 'font-face',
  };

  collectFromValueNodes(valueParser(value).nodes, valueStart, run, declarationContext, {
    imageSet: 'none',
    nested: false,
  });
}

/** Where in a value the url() sits, which the shape needs and the resolver does not. */
interface ValuePosition {
  /** Inside `image-set()`, and whether it was the vendor-prefixed spelling. */
  readonly imageSet: 'none' | 'standard' | 'webkit';
  /** Inside some other function — `linear-gradient(url(...))`. */
  readonly nested: boolean;
}

/**
 * Walk the token tree of one declaration value.
 *
 * `insideImageSet` is the only context that matters: a bare string is an image path
 * inside `image-set("a.png" 1x, "b.png" 2x)` and is just a string anywhere else.
 */
function collectFromValueNodes(
  nodes: readonly ValueNode[],
  base: number,
  run: CssRun,
  declaration: DeclarationContext,
  position: ValuePosition,
): void {
  for (const node of nodes) {
    if (node.type === 'function') {
      const name = node.value.toLowerCase();
      if (name === 'url') {
        collectFromUrlFunction(node.nodes, base, run, declaration, position);
        continue;
      }
      // Recurse into every other function so that a `url()` nested in, say, a
      // `linear-gradient()` is still found. Anything that is not image-set counts as
      // nesting, which is its own row: what breaks there is the recursion itself.
      collectFromValueNodes(node.nodes, base, run, declaration, {
        imageSet: isImageSet(name) ? (name.startsWith('-') ? 'webkit' : 'standard') : 'none',
        nested: position.nested || !isImageSet(name),
      });
      continue;
    }

    if (node.type === 'string' && position.imageSet !== 'none') {
      // `sourceIndex` sits on the opening quote; the path starts one after it.
      addReference({
        text: node.value,
        start: base + node.sourceIndex + 1,
        run,
        declaration,
        position,
        quote: node.quote ?? '"',
      });
    }
  }
}

function collectFromUrlFunction(
  nodes: readonly ValueNode[],
  base: number,
  run: CssRun,
  declaration: DeclarationContext,
  position: ValuePosition,
): void {
  const argument = nodes.find((node) => node.type === 'string' || node.type === 'word');
  if (argument === undefined) return; // `url()` with nothing in it.

  addReference({
    text: argument.value,
    start: base + argument.sourceIndex + (argument.type === 'string' ? 1 : 0),
    run,
    declaration,
    position,
    // The quote character, not just whether there was one: `url('x')` and `url("x")`
    // are different rows because they are different tokens to the parser.
    quote: argument.type === 'string' ? (argument.quote ?? '"') : '',
  });
}

/**
 * Which row this url() belongs to.
 *
 * 🔴 **The order IS the ladder from `shapes.ts`** — narrowest independently-failing
 * thing first. A mechanism CSS owns (interpolation, image-set, a custom property, a
 * nested function) beats the host it is embedded in, because those break identically
 * in a `.css` file and inside a `<style>` element. The host only decides what is left.
 */
function shapeOf(input: {
  readonly rawPath: string;
  readonly run: CssRun;
  readonly declaration: DeclarationContext;
  readonly position: ValuePosition;
  readonly quote: string;
}): ShapeId {
  const { rawPath, run, declaration, position, quote } = input;
  const scss = run.extension === '.scss';

  // 1. Preprocessor mechanisms. R78 Q3: a LEADING interpolation varies the directory
  //    and a trailing one varies the name, which is why they are separate rows.
  if (rawPath.includes('#{')) {
    return rawPath.startsWith('#{') ? 'scss.interpolation.leading' : 'scss.interpolation.trailing';
  }
  if (rawPath.includes('@{')) return 'less.interpolation';
  if (rawPath.startsWith('$')) return 'scss.variable';
  if (rawPath.startsWith('@')) return 'less.variable';

  // 2. Constructs CSS itself owns, in every host and every dialect.
  if (position.imageSet === 'webkit') return 'css.image-set.webkit';
  if (position.imageSet === 'standard') return 'css.image-set';
  if (declaration.inFontFace) return 'css.font-face';
  if (declaration.property.startsWith('--')) return 'css.var';
  if (position.nested) return 'css.url.nested';

  // 3. Embedded in something else — the host decides what is left over.
  if (run.hostShape !== undefined) return run.hostShape;

  // 4. A real stylesheet: the dialect, then the quoting.
  if (scss) return 'scss.url';
  if (run.extension === '.less') return 'less.url';
  if (quote === "'") return 'css.url.single';
  if (quote === '"') return 'css.url.double';
  return 'css.url.bare';
}

/**
 * Markers that mean the path is assembled at compile time, not written literally.
 *
 * ⚠️ **`quoted` is not a nicety: without it a parenthesis in a filename made an image
 * invisible.** `url("/images/quote (blue).svg")` is a literal path — inside quotes a
 * parenthesis is just a character — but the function-call test read it as
 * `map-get($m, k)` and marked the reference `unsafe`. It then linked nothing, the
 * asset had zero references, and it was reported **`dead`**: *safe to delete*, about a
 * file the live site serves. Four of them on `scratch-www`, all in one stylesheet.
 *
 * That is R26's class for the third time — spaces and parentheses are how a
 * non-developer names a file, and every repository maintained by professional JS
 * developers is blind to it by construction. The other markers stay unconditional:
 * SCSS and Less interpolation, and the comment that CSS-in-JS substitution leaves
 * behind, all appear *inside* quotes routinely.
 */
function dynamicReason(rawPath: string, quoted: boolean): string | null {
  if (rawPath.includes('#{')) return 'SCSS interpolation: the path is not known statically';
  if (rawPath.includes('@{')) return 'Less interpolation: the path is not known statically';
  if (rawPath.startsWith('$')) return 'SCSS variable: the path is not known statically';
  if (rawPath.startsWith('@')) return 'Less variable: the path is not known statically';
  if (!quoted && rawPath.includes('(')) {
    return 'contains a function call: the path is not known statically';
  }
  // A comment inside a url token is never a literal path. It also stands in for a
  // CSS-in-JS interpolation: the JS adapter replaces every `${...}` with a comment
  // of exactly the same length, so `url(${bg})` arrives here as `url(/*--*/)`.
  if (rawPath.includes('/*')) return 'contains a comment or interpolation, not a literal path';
  if (rawPath.includes('\\')) return 'contains a CSS escape sequence';
  return null;
}

function addReference(input: {
  text: string;
  start: number;
  run: CssRun;
  declaration: DeclarationContext;
  position: ValuePosition;
  /** The quote character the author used, or `''` for an unquoted url token. */
  quote: string;
}): void {
  const { text, start, run, declaration, position, quote } = input;
  const { file, references } = run;
  if (text === '') return;
  if (isExternalUrl(text, 'css-url')) return;

  const shape = shapeOf({ rawPath: text, run, declaration, position, quote });

  // Inside quotes a `(` is an ordinary character, which is what R26's
  // `url("/images/quote (blue).svg")` turns on.
  const reason = dynamicReason(text, quote !== '');
  if (reason !== null) {
    // Reported, never rewritten. These are the cases where guessing would corrupt
    // a file, so the honest answer is to say what we saw and why we left it alone.
    references.push({
      file,
      start,
      end: start + text.length,
      rawPath: text,
      kind: 'css-url',
      shape,
      ceiling: 'unsafe',
      asserted: true,
      note: reason,
    });
    return;
  }

  const { path, suffix } = splitPathSuffix(text);
  if (path === '') return; // A bare `?query` names no file.

  references.push({
    file,
    start,
    // The range covers the path only, so a rewrite keeps the author's `?v=2`.
    end: start + path.length,
    rawPath: path,
    kind: 'css-url',
    shape,
    ceiling: 'high',
    asserted: true,
    ...(suffix === '' ? {} : { note: `query or fragment preserved: ${suffix}` }),
  });
}
