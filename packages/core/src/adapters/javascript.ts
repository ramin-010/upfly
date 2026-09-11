/**
 * The JavaScript / TypeScript / JSX adapter.
 *
 * Finds static `import`s, `require()`, dynamic `import()`, the Vite-style
 * `new URL('./x.png', import.meta.url)`, JSX `src`/`srcSet`/`poster`, and `url()`
 * inside CSS-in-JS template literals.
 *
 * This adapter is parsed with `@babel/parser` and never with a regular expression,
 * and that rule is not stylistic. A regex finds `'./logo.png'` inside a comment,
 * inside an unrelated string, and inside code that was deleted months ago — and
 * then the rewrite stage edits those positions. That is the silent corruption this
 * whole project exists to prevent, so the one place it would be easiest to cut the
 * corner is the one place we do not.
 */

import { parse } from '@babel/parser';
import type {
  Node as BabelNode,
  ImportDeclaration,
  ImportExpression,
  JSXAttribute,
  JSXOpeningElement,
  StringLiteral,
  TaggedTemplateExpression,
  TemplateLiteral,
} from '@babel/types';
import { UpflyError } from '../errors.js';
import { extensionOf } from '../paths.js';
import type { Adapter, Confidence, RawReference, ReferenceKind } from '../types.js';
import { findCssReferences } from './css.js';
import { defineAdapter } from './define.js';
import { isExternalUrl, parseSrcset, splitPathSuffix } from './reference-path.js';

/**
 * Which babel plugins each extension needs.
 *
 * `.ts` and `.tsx` differ for a real reason: in a `.ts` file `<string>value` is a
 * type assertion, and in a `.tsx` file it opens a JSX element. Enabling `jsx`
 * everywhere would make valid TypeScript unparseable.
 */
const TYPESCRIPT_PLUGINS: readonly string[] = ['typescript', 'decorators-legacy'];
const JAVASCRIPT_PLUGINS: readonly string[] = ['jsx', 'decorators-legacy'];

const PLUGINS_BY_EXTENSION: ReadonlyMap<string, readonly string[]> = new Map([
  ['.js', JAVASCRIPT_PLUGINS],
  ['.jsx', JAVASCRIPT_PLUGINS],
  ['.mjs', JAVASCRIPT_PLUGINS],
  ['.cjs', JAVASCRIPT_PLUGINS],
  ['.ts', TYPESCRIPT_PLUGINS],
  ['.mts', TYPESCRIPT_PLUGINS],
  ['.cts', TYPESCRIPT_PLUGINS],
  ['.tsx', [...TYPESCRIPT_PLUGINS, 'jsx']],
]);

/** JSX attributes that hold an asset path, matched case-insensitively. */
const JSX_URL_ATTRIBUTES: ReadonlySet<string> = new Set(['src', 'srcset', 'poster']);

/**
 * Inline-SVG elements whose `href` names a file, keyed by lowercased tag name (R26).
 *
 * ⚠️ **Tag-scoped, unlike `JSX_URL_ATTRIBUTES`, and that is the whole point.** Adding a
 * bare `href` to the set above would have made every `<a href>` a candidate — including
 * `<a href="/report.pdf">`, where the resolver would then have to decide what a link to
 * a non-image means. `<image>` and `<feImage>` are unambiguous: their `href` is always a
 * file.
 *
 * `xlinkhref` is the React spelling of SVG 1.1's `xlink:href`, and `xlink:href` itself
 * arrives as a `JSXNamespacedName` — both are still overwhelmingly what shipped markup
 * contains, so both are here.
 */
const JSX_SVG_HREF_ELEMENTS: ReadonlyMap<string, readonly string[]> = new Map([
  ['image', ['href', 'xlinkhref', 'xlink:href']],
  ['feimage', ['href', 'xlinkhref', 'xlink:href']],
]);

/**
 * Tag functions whose template literal contains CSS.
 *
 * Matched on the root identifier, so `styled.div`, `styled(Button)` and
 * `styled.div.attrs({})` all resolve to `styled`.
 */
const CSS_IN_JS_TAGS: ReadonlySet<string> = new Set([
  'styled',
  'css',
  'createGlobalStyle',
  'keyframes',
  'injectGlobal',
]);

export const javascriptAdapter: Adapter = defineAdapter({
  id: 'javascript',
  extensions: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'],

  findReferences({ file, text }): RawReference[] {
    const plugins = PLUGINS_BY_EXTENSION.get(extensionOf(file));
    if (plugins === undefined) {
      throw new UpflyError(
        'ADAPTER_PARSE_FAILED',
        `The javascript adapter does not handle ${extensionOf(file) || 'files without an extension'} (${file}).`,
      );
    }

    let ast: BabelNode;
    try {
      ast = parse(text, {
        sourceType: 'unambiguous',
        // `unambiguous` lets one adapter read both ESM and CommonJS without being
        // told which a file is, which no build config reliably tells us anyway.
        allowReturnOutsideFunction: true,
        plugins: [...plugins] as never,
      });
    } catch (error) {
      // Returning [] would report a file we could not read as having no references,
      // which is a silent skip and a P0 bug under rule 9.
      const detail = error instanceof Error ? error.message : String(error);
      throw new UpflyError(
        'ADAPTER_PARSE_FAILED',
        // No `${file}` — see the note in `css.ts`. The report already names it.
        `Could not parse: ${templateSourceReason(text) ?? detail}`,
      );
    }

    const context: Context = { file, text, references: [], speculative: [], handled: new Set() };
    walk(ast, (node) => collectFromNode(node, context));

    // A speculative string whose range a real construct already claimed is that
    // construct's reference, not a second one. Filtering afterwards rather than
    // during the walk keeps this independent of visit order, which `walk` does not
    // promise.
    const claimed = new Set(context.references.map((reference) => reference.start));
    const guesses = context.speculative.filter(
      (reference) =>
        !claimed.has(reference.start) &&
        !claimed.has(reference.start + 1) &&
        !context.handled.has(reference.start),
    );

    return [...context.references, ...guesses].sort((a, b) => a.start - b.start);
  },
});

/**
 * Whether a file that will not parse is a **template** wearing a code extension.
 *
 * `eleventy-docs/src/_includes/snippets/pagination/**` are ten `.js` and `.cjs`
 * files that open with `{% raw %}` — Nunjucks source, carrying a JavaScript
 * extension because Eleventy includes them as text. Failing to parse them is
 * correct. Saying **"Unexpected token (1:1)"** is not: it tells a reader their
 * JavaScript is broken, when the file was never JavaScript.
 *
 * Deliberately only consulted **after** the parser has already failed, and only on
 * the first non-blank line. Anything looser would start second-guessing Babel about
 * files that parse perfectly well — a `.js` file may legitimately contain `{%` in a
 * string, and it is not this function's business unless the parse has already
 * failed on it.
 */
function templateSourceReason(text: string): string | null {
  const firstLine =
    text
      .split('\n')
      .find((line) => line.trim() !== '')
      ?.trim() ?? '';

  for (const [opener, syntax] of TEMPLATE_OPENERS) {
    if (firstLine.startsWith(opener)) {
      return `this looks like ${syntax} template source rather than JavaScript — it begins with \`${opener}\``;
    }
  }
  return null;
}

/** Openers that mark a file as template source, and what to call each. */
const TEMPLATE_OPENERS: readonly (readonly [string, string])[] = [
  ['{%', 'Nunjucks, Jinja or Liquid'],
  ['{{', 'Handlebars, Mustache or Vue'],
  ['<%', 'EJS or ERB'],
  ['---', 'a frontmatter-prefixed'],
];

interface Context {
  readonly file: string;
  readonly text: string;
  readonly references: RawReference[];
  /**
   * Path-shaped string literals no known construct claimed.
   *
   * Kept separate until the walk finishes so they can be filtered against what the
   * real constructs found — see `findReferences`.
   */
  readonly speculative: RawReference[];
  /**
   * Offsets of string literals a construct examined and *declined*.
   *
   * A decline is a decision, not an absence — `alt="/not.png"` is display text. The
   * speculative string rule must not overturn it.
   */
  readonly handled: Set<number>;
}

/** Keys that hold position or comment data rather than child nodes. */
const NON_CHILD_KEYS: ReadonlySet<string> = new Set([
  'loc',
  'leadingComments',
  'trailingComments',
  'innerComments',
  'extra',
]);

function walk(node: unknown, visit: (node: BabelNode) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (node === null || typeof node !== 'object') return;

  const record = node as Record<string, unknown>;
  if (typeof record.type === 'string') visit(node as BabelNode);

  for (const key of Object.keys(record)) {
    if (NON_CHILD_KEYS.has(key)) continue;
    walk(record[key], visit);
  }
}

function collectFromNode(node: BabelNode, context: Context): void {
  switch (node.type) {
    case 'ImportDeclaration':
      collectFromImportDeclaration(node, context);
      return;
    case 'ImportExpression':
      collectFromImportExpression(node, context);
      return;
    case 'CallExpression':
      if (isRequireCall(node)) {
        collectFromModuleSource(node.arguments[0], context, 'certain', 'require()');
      }
      return;
    case 'NewExpression':
      if (isBundlerUrlConstruction(node)) {
        collectFromModuleSource(node.arguments[0], context, 'high', 'new URL(…, import.meta.url)');
      }
      return;
    case 'JSXOpeningElement':
      collectFromJsxSvgImage(node, context);
      return;
    case 'JSXAttribute':
      collectFromJsxAttribute(node, context);
      return;
    case 'TaggedTemplateExpression':
      collectFromTaggedTemplate(node, context);
      return;
    case 'StringLiteral':
      collectSpeculativeString(node, context);
      return;
    case 'TemplateLiteral':
      collectSpeculativeTemplate(node, context);
      return;
    default:
  }
}

/**
 * A path-shaped string literal that no construct above claimed.
 *
 * The adapter reads `import`, `require`, `import()`, JSX attributes, CSS-in-JS and
 * `new URL(…, import.meta.url)`. Everything else was invisible — and that produced a
 * **false `dead`** on astro-docs, where an asset is referenced by
 * `path: './src/pages/open-graph/_images/docs-logo.png'` in an object literal. The
 * sweep could not rescue it either: that file was read successfully and simply
 * yielded no reference, so neither of its haystacks covered it.
 *
 * The asymmetry was indefensible on its own terms. `{ "file": "x.png" }` in
 * `data.json` is a candidate; the identical string in `data.ts` was invisible.
 *
 * So these are emitted **speculative**, exactly as the JSON adapter emits its
 * strings: one that resolves becomes a real link — which is strictly better than a
 * hedge, because Phase 2 can then act on it — and one that does not is `discarded`
 * silently, which is already the ruled behaviour for a guess.
 */
/**
 * Whether a bare string is shaped enough like a path to guess at (R26).
 *
 * ⚠️ **The line this replaces said `a path never contains whitespace`, and that is
 * simply false.** Spaces come from every CMS upload and every dragged-in file, so
 * `["/ncc/Firing Practice.webp"]` yielded nothing and the asset came back a confident
 * `dead` — *"safe to delete"* about a file on a live site. The claim was stated as fact
 * in a comment, which is why nobody questioned it.
 *
 * A comma still disqualifies: that is the unsplit `srcSet` shape
 * (`"/a.jpg 1x, /b.jpg 2x"`), which is a list rather than a path. So are tabs and
 * newlines, which no real path carries.
 *
 * **A space is allowed only alongside a `/`, and that rule is measured rather than
 * guessed.** Two repositories point opposite ways and separate cleanly:
 *
 * - `D:/RBU/RBU-Website`: **109** quoted image paths contain a space, and **109 of 109
 *   contain a slash.** Every real case is a served path.
 * - `shadcn-ui`: **87** quoted strings contain a space and end in an image extension,
 *   and **0 of 87 contain a slash.** All 13 distinct values are accessible UI labels —
 *   `"Remove workspace.png"`, `"Open desk-reference.jpg"`. Prose, not paths.
 *
 * Without the slash, a spaced string is indistinguishable from a sentence, and treating
 * one as a reference risks the expensive direction: a speculative string that *resolves*
 * becomes a real link Phase 2 will rewrite.
 *
 * ⚠️ **The known limit, deliberately not widened:** a bare spaced filename with no
 * separator — `{ file: 'My Logo.svg' }`, R14's shape with a space in it — stays
 * invisible. **Measured frequency across all four repositories: zero.** It is pinned by
 * a test in `javascript.test.ts` so the gap is written down rather than silent, and
 * widening it is one clause here.
 */
function plausiblePathShape(path: string): boolean {
  if (/[\t\n\r,]/.test(path)) return false;
  if (!path.includes(' ')) return true;
  return SPACED_PATH.test(path) && path.includes('/');
}

/**
 * A string that is *nothing but* a path, allowing single spaces inside it.
 *
 * ⚠️ **The slash rule alone was not enough, and the suite caught it.** `never mistakes
 * text for code` failed on three cases that contain both a space and a slash:
 *
 * ```
 * "see ./old.png for details"        prose in an object property
 * `we removed ./old.png last week`   prose in a template
 * "import logo from './old.png'"     an import statement quoted as text
 * ```
 *
 * What separates those from `/ncc/Firing Practice.webp` is not the slash — it is that
 * **prose continues after the extension.** So the pattern is anchored at both ends and
 * must finish on a real extension: `.` followed only by letters or digits. That rejects
 * `.png for details` (spaces after the dot) and `.png'` (a trailing quote), while
 * `.webp` and `.jpg` pass.
 *
 * `*` is in the character class because `collectSpeculativeTemplate` joins its holes with
 * one, so `` `/gallery/Firing Practice ${n}.webp` `` arrives here as
 * `/gallery/Firing Practice *.webp`.
 *
 * ⚠️ **`(` and `)` are here, and only here — this is a per-syntax fix, not a global one.**
 * `WhatsApp Image 2026-03-11 at 1.29.35 PM (1).webp` is what a phone screenshot plus a
 * browser's duplicate-download suffix produces, and it is the commonest way a
 * non-developer gets an image into a repository. Measured on `RBU-Website`: **9 images
 * carry a paren and 4 of them were referenced and reported `dead` anyway** — 0.7% of 553.
 *
 * A string literal is already a quoted context, so a paren inside it is an ordinary
 * character. **It is not one everywhere else**: in unquoted CSS `url(…)` and in bare
 * Markdown `![](…)` a paren is the closing delimiter, and admitting it there breaks the
 * parse rather than widening it. Both of those have quoted and angle-bracket forms that
 * already carry such a name correctly, so nothing is lost by leaving them alone. Measured:
 * of twelve reference positions, **only the bare string literal lost a paren path**.
 *
 * The end anchor is what keeps this safe. `"url(hero.png)"` as a bare JS string ends on
 * `)`, not on an extension, so it is still rejected — the widening admits filenames, not
 * function calls.
 *
 * Note that `extensionOf` cannot do this job: `extname('see ./old.png for details')`
 * returns `'.png for details'`, which is non-empty, so the extension check upstream was
 * satisfied by prose all along — the old whitespace ban was what had been hiding it.
 */
const SPACED_PATH = /^[\w@.\-/*()]+(?: [\w@.\-/*()]+)*\.[A-Za-z0-9]+$/;

function collectSpeculativeString(node: StringLiteral, context: Context): void {
  if (node.start === null || node.start === undefined) return;
  if (node.end === null || node.end === undefined) return;

  const start = node.start + 1;
  const raw = context.text.slice(start, node.end - 1);
  // An escaped string's decoded value differs in length from its text, so no range
  // would point at the path. A guess is not worth an unrewritable reference.
  if (raw !== node.value) return;

  const { path } = splitPathSuffix(raw);
  // Anything with a file extension is a candidate — the same bound the JSON adapter
  // uses. Deciding what an *asset* extension is stays with the resolver, which is
  // the one place that policy lives.
  if (path === '' || extensionOf(path) === '' || isExternalUrl(raw, 'string')) return;
  if (!plausiblePathShape(path)) return;

  context.speculative.push({
    file: context.file,
    start,
    end: start + path.length,
    rawPath: path,
    kind: 'string',
    ceiling: 'high',
    asserted: false,
    note: 'a path-shaped string literal, guessed rather than asserted',
  });
}

/**
 * A path-shaped template literal that no construct above claimed.
 *
 * The sibling of `collectSpeculativeString`, and it was missed on the first pass —
 * which cost two false `dead` findings on astro-docs. `` `./_images/background-${dir}.png` ``
 * in an object property is not a string literal, so the speculative string rule did
 * not see it, and no basename sweep ever could: the text `background-ltr.png` does
 * not exist anywhere.
 *
 * But the right machinery already existed. A template carries a `medium` ceiling,
 * the resolver globs it, and `resolved-pattern` links **every** match — so both
 * files link, by a path built weeks earlier. The lesson is worth more than the fix:
 * when one mechanism cannot reach a case, check whether a different existing one
 * already does before calling the limit fundamental.
 */
function collectSpeculativeTemplate(node: TemplateLiteral, context: Context): void {
  if (node.start === null || node.start === undefined) return;
  if (context.handled.has(node.start)) return;

  // Bound it the same way the string rule is bounded: the static text has to look
  // like a path with a file extension. `${x} items` is not a candidate.
  //
  // ⚠️ The holes become `*` rather than being deleted, which is how the resolver
  // globs them — and joining the quasis *without* a placeholder silently lost the
  // commonest templated path there is. `` `./images/${name}.png` `` concatenated to
  // `./images/.png`, whose last segment is a **dotfile**, so `extensionOf` returned
  // `''` and the reference was dropped. Every `` `/images/${slug}.png` `` in a
  // gallery or CMS data object went with it — and since no basename exists for the
  // sweep to find either, those assets were reported **confidently dead**.
  //
  // It only ever worked when the hole was not the whole filename stem, which is why
  // R14-1b's `background-${dir}.png` and the plan's own `${base}/img/hero.png` both
  // pass and the plan's other example, `./images/${name}.png`, did not.
  const literal = node.quasis.map((quasi) => quasi.value.raw).join('*');
  if (extensionOf(splitPathSuffix(literal).path) === '') return;
  // The same shape test as the string rule, and for the same reason (R26): a template
  // that builds `/gallery/Firing Practice ${n}.webp` is a path, not a sentence. Sharing
  // the predicate is what keeps the two speculative collectors from disagreeing about
  // what a path looks like — they disagreed about nothing else.
  if (!plausiblePathShape(literal)) return;

  addTemplateReference(node, context, 'string', 'a path-shaped template literal', false);
}

function collectFromImportDeclaration(node: ImportDeclaration, context: Context): void {
  // `import type { X } from './x'` is erased at compile time and never loads a file.
  if (node.importKind === 'type') return;
  collectFromModuleSource(node.source, context, 'certain', 'static import');
}

function collectFromImportExpression(node: ImportExpression, context: Context): void {
  collectFromModuleSource(node.source, context, 'certain', 'dynamic import()');
}

function isRequireCall(node: BabelNode): boolean {
  return (
    node.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    node.callee.name === 'require' &&
    node.arguments.length > 0
  );
}

/**
 * Whether this is `new URL('./x.png', import.meta.url)`.
 *
 * The second argument is required rather than optional: with it, this is the
 * bundler-resolved asset pattern that Vite and webpack 5 both document. Without it,
 * `new URL('/x.png')` is an ordinary runtime URL and not a build-time reference.
 */
function isBundlerUrlConstruction(node: BabelNode): boolean {
  if (node.type !== 'NewExpression') return false;
  if (node.callee.type !== 'Identifier' || node.callee.name !== 'URL') return false;

  const [, second] = node.arguments;
  return (
    second !== undefined &&
    second.type === 'MemberExpression' &&
    second.object.type === 'MetaProperty' &&
    second.property.type === 'Identifier' &&
    second.property.name === 'url'
  );
}

function collectFromJsxAttribute(node: JSXAttribute, context: Context): void {
  const value = node.value;
  if (value === null || value === undefined) return;

  // Every JSX attribute value is *examined* here, even one this function declines.
  // `alt="/not.png"` is display text, and the speculative string rule would
  // otherwise link and rewrite it — turning a deliberate decision into noise.
  // Recording the examination is how a later pass knows not to second-guess it.
  if (value.type === 'StringLiteral' && typeof value.start === 'number') {
    context.handled.add(value.start + 1);
  }
  if (value.type === 'JSXExpressionContainer' && value.expression.type === 'StringLiteral') {
    const literal = value.expression;
    if (typeof literal.start === 'number') context.handled.add(literal.start + 1);
  }

  const name = node.name.type === 'JSXIdentifier' ? node.name.name : '';
  if (!JSX_URL_ATTRIBUTES.has(name.toLowerCase())) return;

  // `srcSet` holds a candidate list, not a path. Left unsplit it produces two false
  // positives at once: the whole string resolves to nothing, and every image in it
  // but the first gains no reference and looks dead.
  const isSrcSet = name.toLowerCase() === 'srcset';

  addJsxAttributeValue(value, context, `JSX ${name}`, isSrcSet);
}

/**
 * Emit a reference for a JSX attribute value, whatever shape it takes.
 *
 * Extracted so the tag-scoped inline-SVG handler below reads values identically to
 * `src`/`srcSet`/`poster`. A second copy would have been a second place for a template
 * literal in an attribute to stop being understood.
 */
function addJsxAttributeValue(
  value: JSXAttribute['value'],
  context: Context,
  label: string,
  isSrcSet: boolean,
): void {
  if (value === null || value === undefined) return;

  if (value.type === 'StringLiteral') {
    addLiteralReference(value, context, 'high', 'attr', label, isSrcSet);
    return;
  }

  if (value.type === 'JSXExpressionContainer') {
    const expression = value.expression;
    if (expression.type === 'StringLiteral') {
      addLiteralReference(expression, context, 'high', 'attr', label, isSrcSet);
      return;
    }
    if (expression.type === 'TemplateLiteral') {
      addTemplateReference(expression, context, 'attr', label);
    }
    // Anything else — an identifier, a call, a conditional — is a value, not a
    // path. The import that produced it was already captured on its own.
  }
}

/** The attribute's written name, including a namespace such as `xlink:href`. */
function jsxAttributeName(attribute: JSXAttribute): string {
  const name = attribute.name;
  if (name.type === 'JSXIdentifier') return name.name;
  return `${name.namespace.name}:${name.name.name}`;
}

/**
 * `<image href>` and `<feImage href>` inside JSX — R26's second defect.
 *
 * ⚠️ **Handled at the element rather than the attribute, because `href` alone is not
 * enough to know.** ARCHITECTURE.md recorded this as a known gap *"for `.svg` files"*,
 * which is why nobody looked: an inline `<svg>` in a JSX component is not an `.svg`
 * file, so no future SVG adapter would ever have reached it. One of R26's eight misses
 * was this, and the HTML adapter had the identical hole.
 */
function collectFromJsxSvgImage(node: JSXOpeningElement, context: Context): void {
  const tag = node.name.type === 'JSXIdentifier' ? node.name.name.toLowerCase() : '';
  const attributes = JSX_SVG_HREF_ELEMENTS.get(tag);
  if (attributes === undefined) return;

  for (const attribute of node.attributes) {
    if (attribute.type !== 'JSXAttribute') continue;
    if (!attributes.includes(jsxAttributeName(attribute).toLowerCase())) continue;
    addJsxAttributeValue(attribute.value, context, `JSX <${tag}> href`, false);
  }
}

/** Handle an import/require/URL argument, which may be a string or a template. */
function collectFromModuleSource(
  source: BabelNode | null | undefined,
  context: Context,
  ceiling: Confidence,
  description: string,
): void {
  if (source === null || source === undefined) return;
  if (source.type === 'StringLiteral') {
    addLiteralReference(source, context, ceiling, 'import', description);
    return;
  }
  if (source.type === 'TemplateLiteral') {
    addTemplateReference(source, context, 'import', description);
  }
}

function collectFromTaggedTemplate(node: TaggedTemplateExpression, context: Context): void {
  // Claimed here, whatever this decides: a `styled.div` body is CSS, not a path.
  if (typeof node.quasi.start === 'number') context.handled.add(node.quasi.start);
  if (!CSS_IN_JS_TAGS.has(rootIdentifierName(node.tag) ?? '')) return;

  const flattened = flattenTemplate(node.quasi, context.text);
  if (flattened === null) return;

  try {
    context.references.push(
      ...findCssReferences({
        file: context.file,
        text: flattened.text,
        baseOffset: flattened.start,
        // SCSS rather than plain CSS: styled-components nest like SCSS, and the
        // `#{…}` placeholders standing in for interpolations are native SCSS.
        extension: '.scss',
      }),
    );
  } catch {
    // A template whose CSS does not parse is usually one built from fragments.
    // Report it rather than dropping it, and never rewrite it.
    context.references.push({
      file: context.file,
      start: flattened.start,
      end: flattened.start + flattened.text.length,
      rawPath: flattened.text,
      kind: 'css-url',
      ceiling: 'unsafe',
      asserted: false,
      note: 'CSS-in-JS template could not be parsed as CSS, so it was left alone',
    });
  }
}

/** Walk down `styled.div.attrs({})` and friends to the identifier at the root. */
function rootIdentifierName(node: BabelNode): string | null {
  let current: BabelNode = node;
  for (;;) {
    if (current.type === 'Identifier') return current.name;
    if (current.type === 'MemberExpression') {
      current = current.object;
      continue;
    }
    if (
      (current.type === 'CallExpression' || current.type === 'NewExpression') &&
      current.callee.type !== 'V8IntrinsicIdentifier'
    ) {
      current = current.callee;
      continue;
    }
    return null;
  }
}

/**
 * Turn a template literal into a single run of text whose offsets still line up
 * with the file.
 *
 * Every `${…}` is replaced by a CSS comment of exactly the same length, so the CSS
 * stays parseable and the offsets of everything after it are unchanged. The shortest
 * possible expression is `${x}` at four characters, and the shortest comment `/**​/`
 * is also four, so this never has to shorten anything.
 *
 * A comment rather than a SCSS interpolation because an interpolation is only valid
 * where a value is expected. `styled.div` templates routinely open with a mixin at
 * statement level:
 *
 *     styled.div`
 *       ${baseStyles}
 *       background: url(/hero.png);
 *     `
 *
 * `#{…}` there fails to parse and would cost us the real `url()` below it, whereas a
 * comment is valid both at statement level and inside a value. The CSS scanner
 * already treats a `url()` containing `/*` as dynamic, so an interpolated path stays
 * unsafe rather than being mistaken for a literal one.
 */
function flattenTemplate(
  template: TemplateLiteral,
  text: string,
): { text: string; start: number } | null {
  const first = template.quasis[0];
  const last = template.quasis[template.quasis.length - 1];
  if (first?.start === null || first?.start === undefined) return null;
  if (last?.end === null || last?.end === undefined) return null;

  const start = first.start;
  const end = last.end;
  let flattened = '';
  let cursor = start;

  for (const quasi of template.quasis) {
    if (quasi.start === null || quasi.start === undefined) return null;
    if (quasi.end === null || quasi.end === undefined) return null;

    if (quasi.start > cursor) {
      // The gap between two quasis is exactly the `${…}` span.
      flattened += placeholderOfLength(quasi.start - cursor);
    }
    flattened += text.slice(quasi.start, quasi.end);
    cursor = quasi.end;
  }

  return flattened.length === end - start ? { text: flattened, start } : null;
}

function placeholderOfLength(length: number): string {
  if (length < 4) return ' '.repeat(length);
  return `/*${'-'.repeat(length - 4)}*/`;
}

function addLiteralReference(
  literal: StringLiteral,
  context: Context,
  ceiling: Confidence,
  kind: ReferenceKind,
  description: string,
  /** Treat the value as a `srcset` candidate list rather than a single path. */
  isSrcSet = false,
): void {
  if (literal.start === null || literal.start === undefined) return;
  if (literal.end === null || literal.end === undefined) return;

  // The literal's range includes its quotes; the path is what sits between them.
  const start = literal.start + 1;
  const end = literal.end - 1;
  const raw = context.text.slice(start, end);

  if (raw !== literal.value) {
    // The source contains escape sequences, so the decoded value is a different
    // length from the text and no range would point at the path correctly.
    addReference({
      context,
      start,
      end,
      rawPath: raw,
      kind,
      ceiling: 'unsafe',
      note: `${description}: the string contains escape sequences, so its path text cannot be located exactly`,
      skipPathChecks: true,
    });
    return;
  }

  if (isSrcSet) {
    for (const candidate of parseSrcset(raw)) {
      addReference({
        context,
        start: start + candidate.offset,
        end: start + candidate.offset + candidate.url.length,
        rawPath: candidate.url,
        kind,
        ceiling,
        note: description,
      });
    }
    return;
  }

  addReference({ context, start, end, rawPath: raw, kind, ceiling, note: description });
}

/**
 * A template literal used as a path.
 *
 * With no expressions it is just a string. With expressions it has a static prefix
 * and holes, which is the `medium` tier: the resolver decides whether the pattern
 * picks out exactly one asset, and must never fall one of these through to `broken`
 * — nobody typed a path that points at nothing.
 */
function addTemplateReference(
  template: TemplateLiteral,
  context: Context,
  kind: ReferenceKind,
  description: string,
  asserted = true,
): void {
  const flattened = flattenTemplate(template, context.text);
  if (flattened === null) return;

  const hasExpressions = template.expressions.length > 0;
  const raw = context.text.slice(flattened.start, flattened.start + flattened.text.length);

  addReference({
    context,
    start: flattened.start,
    end: flattened.start + raw.length,
    rawPath: raw,
    kind,
    ceiling: hasExpressions ? 'medium' : 'high',
    note: hasExpressions
      ? `${description}: a template literal with a static prefix; the resolver decides whether it names exactly one asset`
      : description,
    skipPathChecks: hasExpressions,
    asserted,
  });
}

function addReference(input: {
  context: Context;
  start: number;
  end: number;
  rawPath: string;
  kind: ReferenceKind;
  ceiling: Confidence;
  note: string;
  /** Set when the text is not a plain path, so suffix splitting would be wrong. */
  skipPathChecks?: boolean;
  /** `false` for a path-shaped guess, which can never become a `broken` finding. */
  asserted?: boolean;
}): void {
  const {
    context,
    start,
    rawPath,
    kind,
    ceiling,
    note,
    skipPathChecks = false,
    asserted = true,
  } = input;
  if (rawPath === '') return;
  const into = asserted ? context.references : context.speculative;

  // Above the `skipPathChecks` branch, not inside it (R21). That flag means *suffix
  // splitting would be wrong on this text* — which is what its own comment says —
  // and it was also skipping the external-URL test, so every templated URL in the
  // codebase became an `unsafe` reference. On `astro-docs` that bucket, which §1.1
  // shows users as "references I couldn't safely rewrite", contained
  // `https://${previewBranch}.previews.docs.astro.build/` and an npm registry call
  // and no images at all.
  //
  // A URL is external whatever its holes interpolate to: `https://${branch}.x.com/`
  // is hosted somewhere we do not manage, and `` `${base}/hero.png` `` still starts
  // with a hole rather than a scheme, so it is untouched.
  if (isExternalUrl(rawPath, kind)) return;

  if (skipPathChecks) {
    into.push({
      file: context.file,
      start,
      end: input.end,
      rawPath,
      kind,
      ceiling,
      asserted,
      note,
    });
    return;
  }

  const { path, suffix } = splitPathSuffix(rawPath);
  if (path === '') return;

  into.push({
    file: context.file,
    start,
    // The range covers the path alone, so a rewrite preserves any `?raw` or `?v=2`
    // suffix — which in a Vite project changes what the import actually returns.
    end: start + path.length,
    rawPath: path,
    kind,
    ceiling,
    asserted,
    note: suffix === '' ? note : `${note}; query or fragment preserved: ${suffix}`,
  });
}
