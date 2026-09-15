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

import postcss, { type AtRule, type Declaration, type Root } from 'postcss';
import lessParser from 'postcss-less';
import scssParser from 'postcss-scss';
import valueParser, { type Node as ValueNode } from 'postcss-value-parser';
import { UpflyError } from '../errors.js';
import { extensionOf } from '../paths.js';
import type { ShapeId } from '../shapes.js';
import type { Adapter, RawReference } from '../types.js';
import { defineAdapter } from './define.js';
import { parseFailure } from './parse-failure.js';
import {
  assembledPathIsGlobbable,
  interpolationChunks,
  isExternalUrl,
  plausiblePathShape,
  splitPathSuffix,
} from './reference-path.js';

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
  const run: CssRun = { file, baseOffset, extension, hostShape, references };
  root.walkDecls((declaration) => {
    collectFromDeclaration(declaration, run);
  });
  // 🔴 A SECOND WALK, BECAUSE LESS'S VARIABLES ARE A DIFFERENT NODE TYPE. `$hero: '…'` is a
  // Declaration to postcss-scss and reaches `walkDecls`; `@hero: '…'` is an AT-RULE to
  // postcss-less — `@` opens an at-rule in CSS's grammar — so it never reaches `walkDecls`
  // at all and no amount of work inside `collectFromDeclaration` could have found it.
  // ⚠️ Two mechanisms, and the key already had that right: `scss.url` and `less.url` are
  // separate rows, and R82's ladder says a thing that fails differently IS a separate row.
  if (extension === '.less') {
    root.walkAtRules((atRule) => {
      collectFromVariableAtRule(atRule, run);
    });
  }

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

/** What one declaration adds: the things that decide a shape on their own. */
interface DeclarationContext {
  /** `--brand-image` means the url is reached through a custom property. */
  readonly property: string;
  /** `@font-face` bodies hold fonts, which are real files the engine never indexes. */
  readonly inFontFace: boolean;
  /**
   * A preprocessor variable declaration — `$hero: '/img/hero.jpg'` or
   * `@hero: "/img/hero.jpg"`. A bare quoted string is a PATH here and is not one in an
   * ordinary declaration, where `content: "note.png"` is text. See
   * `collectVariableDeclarationString`.
   */
  readonly isVariableDeclaration: boolean;
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
    // `$hero: '…'` reaches `walkDecls` as an ordinary declaration whose property starts
    // with `$`. Less's `@hero: '…'` does NOT — it is an at-rule, and
    // `collectFromVariableAtRule` handles it.
    isVariableDeclaration: run.extension === '.scss' && property.startsWith('$'),
  };

  collectFromValueNodes(valueParser(value).nodes, valueStart, run, declarationContext, {
    imageSet: 'none',
    nested: false,
  });
}

/**
 * Less's `@hero: '/img/hero.jpg'`, which the declaration walk never sees.
 *
 * postcss-less marks these `variable: true` and puts the text in both `params` and
 * `value`. **The flag is checked rather than the shape of the name**, so `@media`,
 * `@import` and `@font-face` cannot fall in here by resembling one.
 *
 * ⚠️ The offset is computed as `@` + name + `afterName`, which is where postcss-less keeps
 * the colon and the spacing around it. Measured against the source text rather than
 * assumed: `@banner:   "…"` with three spaces lands on the opening quote exactly, and the
 * range invariant `source.slice(start, end) === rawPath` is the thing that must not move.
 */
function collectFromVariableAtRule(atRule: AtRule, run: CssRun): void {
  const { variable, name, params } = atRule as AtRule & { variable?: boolean };
  if (variable !== true || params === '') return;

  const atRuleStart = atRule.source?.start?.offset;
  if (atRuleStart === undefined) {
    throw new UpflyError(
      'ADAPTER_PARSE_FAILED',
      `PostCSS returned an at-rule without a source position in ${run.file}.`,
    );
  }

  const afterName = atRule.raws.afterName ?? ':';
  const valueStart = run.baseOffset + atRuleStart + 1 + name.length + afterName.length;

  collectFromValueNodes(
    valueParser(params).nodes,
    valueStart,
    run,
    { property: `@${name}`, inFontFace: false, isVariableDeclaration: true },
    { imageSet: 'none', nested: false },
  );
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
      continue;
    }

    if (node.type === 'string' && declaration.isVariableDeclaration && !position.nested) {
      collectVariableDeclarationString(node, base, run, declaration, position);
    }
  }
}

/**
 * A quoted path parked in a preprocessor variable, which is a reference to that file.
 *
 * 🔴 **THE ASSET IS NOT HEDGED, AND THAT IS WHY THIS MATTERS MORE THAN A MISSING ROW.**
 * `$hero: '/img/hero.jpg'` is invisible today, so the only thing the engine sees is
 * `url($hero)` — which it correctly calls `dynamic`, a hedge that protects the *reference*
 * and says nothing about the *file*. If `/img/hero.jpg` is named nowhere else it looks
 * DEAD, and `optimize --replace` will convert it and leave the declaration pointing at a
 * name that no longer exists. **Silently. That is this product's own failure mode aimed at
 * itself**, and it is the argument for reading the declaration rather than for widening
 * the glob on the use.
 *
 * ⚠️ **Not a new rule — the JavaScript adapter has had exactly this one for months.**
 * `collectSpeculativeString` treats a path-shaped string literal as a candidate with
 * `asserted: false` and the note *"guessed rather than asserted"*, and the resolver throws
 * away the ones that hit nothing. The CSS adapter had no equivalent, and **that
 * inconsistency is the case for this change on a repository that has never seen our
 * fixtures** — not that our tree happens to hold six of them.
 *
 * 🔴 **MEASURED ACROSS THE FIVE VALIDATION REPOSITORIES, 2026-09-15, AND THE HONEST RESULT
 * IS TWO-SIDED.** 194 `.scss`/`.less` files, **16** quoted-string variable declarations,
 * **0** of them with a file extension, so this rule adds **0 references and 0 false
 * positives** there. That is strong evidence for its SAFETY and **no evidence at all for
 * its frequency** — the pattern simply does not occur in those five. All 16 near-misses are
 * media queries (`$big: "only screen and (min-width : …)"`), and they are rejected by the
 * extension test rather than by luck. ⚠️ The claim that this shape is common in the wild is
 * a belief about Sass conventions and is NOT measured; what is measured is that reading it
 * costs nothing.
 *
 * **Restricted to variable declarations deliberately.** In an ordinary declaration a bare
 * quoted string is text — `content: "note.png"` is a caption, not a file — so widening this
 * to every declaration would manufacture the false positives R49 warns about. A variable is
 * the one place a whole path is conventionally parked for a `url()` later on.
 *
 * ⚠️ `!position.nested`: inside a function the string is an argument, and the functions
 * that take a path (`url`, `image-set`) are already handled above.
 */
function collectVariableDeclarationString(
  node: ValueNode & { readonly sourceIndex: number; readonly quote?: string },
  base: number,
  run: CssRun,
  declaration: DeclarationContext,
  position: ValuePosition,
): void {
  const { path } = splitPathSuffix(node.value);
  // The same bound the JS and JSON adapters use: anything with a file extension is a
  // candidate, and what counts as an ASSET extension stays with the resolver, which is the
  // one place that policy lives. `$dir: '/gallery'` fails here and must.
  if (path === '' || extensionOf(path) === '' || isExternalUrl(node.value, 'string')) return;
  if (!plausiblePathShape(path)) return;

  addReference({
    text: path,
    // `sourceIndex` sits on the opening quote; the path starts one after it.
    start: base + node.sourceIndex + 1,
    run,
    declaration,
    position,
    quote: node.quote ?? '"',
    // 🔴 A GUESS, AND IT SAYS SO. `asserted: false` is what lets the resolver drop the ones
    // that hit nothing as `discarded` rather than reporting them `broken` — the difference
    // between a hedge and a false positive, and the reason this can be turned on at all.
    asserted: false,
  });
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

  // 1. Interpolation mechanisms — the path is assembled, whoever is holding the file.
  //    R78 Q3: a LEADING interpolation varies the directory and a trailing one varies
  //    the name, which is why they are separate rows.
  if (rawPath.includes('#{')) {
    return rawPath.startsWith('#{') ? 'scss.interpolation.leading' : 'scss.interpolation.trailing';
  }
  if (rawPath.includes('@{')) return 'less.interpolation';
  // ⚠️ THERE IS DELIBERATELY NO `${}` RUNG HERE, and the reason is worth the lines
  //    because the obvious fix is wrong. B7 measured `js.template.pattern -> js.cssinjs`
  //    as a misassignment and it is not one: this function NEVER SEES a `${}`.
  //    `collectFromTaggedTemplate` flattens the template first, substituting each
  //    interpolation with a same-length comment placeholder so the offsets still point
  //    into the real file — so what arrives here is `/theme-/*---*/.png`. A rung testing
  //    for `${` is unreachable code, and adding one changed nothing at all (R89).
  //    🔴 And the shape the engine gives it is RIGHT: the reference comes out `unsafe`,
  //    so the resolver's pattern machinery never runs and `js.cssinjs` is the only thing
  //    that can independently fail here. What is actually wrong is the KEY, which
  //    expects `resolved-pattern` for an outcome the engine reports as `dynamic` —
  //    raised with its measured scope rather than patched from a six-entry probe.
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
/**
 * Whether a `#{…}` / `@{…}` path constrains enough to be globbed rather than given up on.
 *
 * 🔴 **R80(b) WAS RULED, THE CONDITION WAS WRITTEN AND SHARED AND TESTED, AND THE CSS
 * ADAPTER NEVER CALLED IT.** `assembledPathIsGlobbable` has governed the JavaScript
 * adapter's template literals since R89; a SCSS interpolation went straight to `unsafe`,
 * and `resolveOne` refuses an unsafe reference outright, so **`resolved-pattern` was
 * reachable only through a JS template literal.** The rule was not missing — it was
 * unwired, which is the pipeline leaking rather than new work.
 *
 * R78 Q3's distinction, unchanged: a **trailing** interpolation varies the NAME inside a
 * fixed directory and can be globbed; a **leading** one varies the directory and cannot,
 * because the glob would sweep in assets nobody referenced.
 */
function interpolationIsGlobbable(rawPath: string): boolean {
  // 🔴 NOT `splitPathSuffix` FIRST, AND THE FIRST VERSION OF THIS DID EXACTLY THAT.
  // `#` opens a URL FRAGMENT in CSS and opens an INTERPOLATION in SCSS, and
  // `splitPathSuffix` only knows the first meaning — so `/theme-#{$mode}.png` came back
  // as path `/theme-` with fragment `{$mode}.png`. The globbable test then ran on
  // `/theme-`, said yes, and the reference was emitted as `/theme-`: no image extension,
  // dropped at rung 3, **and the matrix went from `dynamic` to `absent`** — a silent skip
  // introduced by the fix for a silent skip. The interpolation markers are checked on the
  // written text, before anything interprets a `#`.
  return assembledPathIsGlobbable(interpolationChunks(rawPath));
}

/** Whether a path carries an interpolation, in any of the three dialects. */
function isInterpolated(text: string): boolean {
  return text.includes('#{') || text.includes('@{');
}

function dynamicReason(rawPath: string, quoted: boolean): string | null {
  // ⚠️ The globbable ones return `null` here so that `addReference` gives them a `medium`
  // ceiling instead of `unsafe`. They are still not literal paths — `matchPattern` is what
  // decides whether the pattern names anything, and falls back to `dynamic` when it does
  // not. So this can only ever ADD links; it cannot turn a dynamic reference broken.
  if (rawPath.includes('#{')) {
    return interpolationIsGlobbable(rawPath)
      ? null
      : 'SCSS interpolation in the directory: too little is fixed to glob (R78 Q3)';
  }
  if (rawPath.includes('@{')) {
    return interpolationIsGlobbable(rawPath)
      ? null
      : 'Less interpolation in the directory: too little is fixed to glob (R78 Q3)';
  }
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
  /**
   * Whether the author SAID this was an asset. A `url()` says so; a quoted string parked
   * in a preprocessor variable only looks like one. Defaults to true, because every
   * caller but `collectVariableDeclarationString` is a construct that asserts.
   *
   * ⚠️ It is what separates a hedge from a false positive: an unasserted path that hits
   * nothing is `discarded`, an asserted one is reported `broken`.
   */
  asserted?: boolean;
}): void {
  const { text, start, run, declaration, position, quote } = input;
  const asserted = input.asserted ?? true;
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
      asserted,
      note: reason,
    });
    return;
  }

  // 🔴 AN INTERPOLATED PATH IS NOT SPLIT, BECAUSE `#` MEANS TWO THINGS. In CSS it opens a
  // fragment; in SCSS it opens an interpolation. `splitPathSuffix` knows only the first, so
  // splitting `/theme-#{$mode}.png` yields the path `/theme-` and throws the rest away as a
  // fragment. Every interpolated reference here is one the author wrote as a whole.
  const interpolated = isInterpolated(text);
  const { path, suffix } = interpolated ? { path: text, suffix: '' } : splitPathSuffix(text);
  if (path === '') return; // A bare `?query` names no file.

  // 🔴 A GLOBBABLE INTERPOLATION IS `medium`, NEVER `high` — and getting this wrong would
  // be worse than the gap it fixes. `dynamicReason` returns `null` for these so they reach
  // this line, but they are not literal paths: at `high` the resolver would look
  // `/theme-#{$mode}.png` up verbatim, find nothing, and report a **broken reference the
  // author never wrote**. `medium` sends it to `matchPattern`, which globs it and falls
  // back to `dynamic` when the pattern names nothing — so this can only ADD links.

  references.push({
    file,
    start,
    // The range covers the path only, so a rewrite keeps the author's `?v=2`.
    end: start + path.length,
    rawPath: path,
    kind: 'css-url',
    shape,
    ceiling: interpolated ? 'medium' : 'high',
    asserted,
    ...(asserted ? {} : { note: 'a path-shaped string literal, guessed rather than asserted' }),
    ...(suffix === '' ? {} : { note: `query or fragment preserved: ${suffix}` }),
  });
}
