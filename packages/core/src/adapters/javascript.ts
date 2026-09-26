/**
 * The JavaScript, TypeScript and JSX adapter.
 *
 * Finds static `import`s, `require()`, dynamic `import()`, the bundler form
 * `new URL('./x.png', import.meta.url)`, JSX `src`/`srcSet`/`poster`, inline-SVG
 * `<image href>`, and `url()` inside CSS-in-JS template literals. Path-shaped strings,
 * templates and `+` chains outside those constructs become speculative candidates.
 *
 * It parses with `@babel/parser`, never a regular expression: a regex would find
 * `'./logo.png'` inside a comment or an unrelated string, and the rewrite would then edit it.
 */

import { parse } from '@babel/parser';
import type {
  Node as BabelNode,
  BinaryExpression,
  File,
  ImportDeclaration,
  ImportExpression,
  JSXAttribute,
  JSXOpeningElement,
  Program,
  StringLiteral,
  TaggedTemplateExpression,
  TemplateLiteral,
} from '@babel/types';
import { UpflyError } from '../errors.js';
import { extensionOf } from '../paths.js';
import type { ShapeId } from '../shapes.js';
import type { Adapter, Confidence, RawReference, ReferenceKind } from '../types.js';
import { findCssReferences } from './css.js';
import { defineAdapter } from './define.js';
import { parseFailure } from './parse-failure.js';
import {
  NOT_GLOBBABLE_REASON,
  assembledPathIsGlobbable,
  interpolationChunks,
  isExternalUrl,
  parseSrcset,
  plausiblePathShape,
  provablyNotAFile,
  splitPathSuffix,
  staticExtensionOf,
} from './reference-path.js';

/**
 * Which Babel plugins each extension needs.
 *
 * `.ts` and `.tsx` differ: in a `.ts` file `<string>value` is a type assertion, and in a
 * `.tsx` file it opens a JSX element. Enabling `jsx` everywhere would make valid
 * TypeScript unparseable.
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
 * Inline-SVG elements whose `href` names a file, keyed by lowercased tag name.
 *
 * Scoped to the tag, unlike `JSX_URL_ATTRIBUTES`: a bare `href` there would make every
 * `<a href>` a candidate, including `<a href="/report.pdf">`, while the `href` of `<image>`
 * and `<feImage>` is always a file. `xlinkhref` is React's `xlinkHref` lowercased, and
 * `xlink:href` arrives as a `JSXNamespacedName`: both spell SVG 1.1's `xlink:href`, which
 * shipped markup still commonly uses.
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
    return findJavaScriptReferences({ file, text, extension: extensionOf(file) });
  },
});

/**
 * Parse JavaScript or TypeScript and collect its image references.
 *
 * Exported for adapters that hold JavaScript inside another format, such as an `.astro`
 * frontmatter fence or the `import`/`export` blocks of an `.mdx` file. `file` stays the
 * host file's path, so every reference cites where a reader will find it, and `extension`
 * names the dialect to parse. Offsets index `text`, so a caller that blanks the rest of the
 * file with spaces, rather than slicing out the region, gets offsets into the original file.
 *
 * @throws {UpflyError} `ADAPTER_PARSE_FAILED` when `extension` is not a JavaScript
 * dialect or the text does not parse.
 */
export function findJavaScriptReferences(input: {
  readonly file: string;
  readonly text: string;
  /** Dialect to parse as, as a dotted extension. */
  readonly extension: string;
}): RawReference[] {
  {
    const { file, text, extension } = input;
    const plugins = PLUGINS_BY_EXTENSION.get(extension);
    if (plugins === undefined) {
      throw new UpflyError(
        'ADAPTER_PARSE_FAILED',
        `The javascript adapter does not handle ${extension || 'files without an extension'} (${file}).`,
      );
    }

    let ast: BabelNode;
    try {
      ast = parseWith(text, plugins);
    } catch (error) {
      // Returning [] would report a file we could not read as having no references, a
      // silent skip. The template sentence comes first because it says what a position
      // cannot: the file is not JavaScript at all. Otherwise the sentence is ours with
      // Babel's position, and Babel's own wording goes to the diagnostic, never the report.
      const template = templateSourceReason(text);
      const failure = parseFailure({ error, dialect: 'JavaScript', position: 'babel' });
      throw new UpflyError(
        'ADAPTER_PARSE_FAILED',
        // No file name: the report already prints the path before this message.
        template === null ? failure.message : `Could not parse: ${template}`,
        [],
        failure.diagnostic,
      );
    }

    const context: Context = {
      file,
      text,
      references: [],
      speculative: [],
      handled: new Set(),
      constantNamed: sameFileConstants((ast as File).program),
      chainParts: new Set(),
    };
    walk(ast, (node) => collectFromNode(node, context));

    // A guess whose range a construct already claimed is that construct's reference,
    // not a second one. Filtering after the walk keeps this independent of visit order,
    // which `walk` does not promise.
    const claimed = new Set(context.references.map((reference) => reference.start));
    const guesses = context.speculative.filter(
      (reference) =>
        !claimed.has(reference.start) &&
        !claimed.has(reference.start + 1) &&
        !context.handled.has(reference.start),
    );

    return [...context.references, ...guesses].sort((a, b) => a.start - b.start);
  }
}

/**
 * The one Babel call. `findJavaScriptReferences` and `javaScriptParseOutcome` both go
 * through it, so the question "does this parse?" can never be asked with different
 * options from the parse that then reads the references.
 */
function parseWith(text: string, plugins: readonly string[]): BabelNode {
  return parse(text, {
    // `unambiguous` reads both ESM and CommonJS without being told which a file is,
    // which no build config reliably says.
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
    plugins: [...plugins] as never,
  });
}

/**
 * Whether `text` parses, and when it does not, whether it stopped early rather than
 * being wrong.
 *
 * MDX ends a top-level `import`/`export` block at the first blank line, unless the code so
 * far is an unfinished prefix, in which case it swallows the blank line and carries on
 * (`micromark-extension-mdxjs-esm`). MDX parses with acorn, which reports an unfinished
 * template, comment or JSX body at the end of the input. Babel reports those where the
 * construct starts, so two signals are read: an unexpected token at the very end, or one
 * of `UNFINISHED_REASON_CODES`. An unterminated string is not among them: a string cannot
 * cross a line, so no further text completes it.
 */
export function javaScriptParseOutcome(
  text: string,
  extension: string,
): 'parses' | 'incomplete' | 'invalid' {
  const plugins = PLUGINS_BY_EXTENSION.get(extension);
  if (plugins === undefined) return 'invalid';
  try {
    parseWith(text, plugins);
    return 'parses';
  } catch (error) {
    const { pos, reasonCode } = error as { pos?: unknown; reasonCode?: unknown };
    if (typeof reasonCode === 'string' && UNFINISHED_REASON_CODES.has(reasonCode)) {
      return 'incomplete';
    }
    return typeof pos === 'number' && pos >= text.trimEnd().length ? 'incomplete' : 'invalid';
  }
}

/** Babel's names for a construct the input ended inside of. See `javaScriptParseOutcome`. */
const UNFINISHED_REASON_CODES: ReadonlySet<string> = new Set([
  'UnterminatedTemplate',
  'UnterminatedComment',
  'UnterminatedJsxContent',
]);

/**
 * Whether a file that will not parse is template source wearing a code extension: the
 * sentence saying so, or `null`.
 *
 * Eleventy includes snippets as text, so a `.js` file can hold Nunjucks that opens with
 * `{% raw %}`. Failing to parse it is correct, but "Unexpected token (1:1)" would tell the
 * reader their JavaScript is broken when the file was never JavaScript.
 *
 * Asked only after the parse has failed, and only of the first non-blank line: a `.js`
 * file that parses may legitimately hold `{%` in a string.
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
   * Guesses: path-shaped strings, templates and `+` chains that no construct claimed.
   *
   * Kept apart until the walk finishes, so `findJavaScriptReferences` can drop any whose
   * range a construct claimed.
   */
  readonly speculative: RawReference[];
  /**
   * Offsets of literals a construct has examined, whether it emitted a reference or
   * declined. A decline is a decision, not an absence: `alt="/not.png"` is display text,
   * and the speculative rules must not overturn it.
   *
   * A string is recorded at the offset after its opening quote and a template literal at
   * its own start, which is what the speculative rules compare against.
   */
  readonly handled: Set<number>;
  /**
   * The value of a same-file constant a path is assembled from, or `null`. See
   * `sameFileConstants` for the one condition under which a name is read through.
   */
  readonly constantNamed: (name: string) => string | null;
  /**
   * The inner `+` nodes of every chain already read. A chain nests down its left side, so
   * the walk meets each inner node after its outer one, and must not read it again as a
   * second, shorter chain.
   */
  readonly chainParts: Set<BabelNode>;
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
        collectFromModuleSource(
          node.arguments[0],
          context,
          'certain',
          moduleSourceShape(node.arguments[0], 'js.require'),
          'require()',
        );
      }
      return;
    case 'NewExpression':
      if (isBundlerUrlConstruction(node)) {
        collectFromModuleSource(
          node.arguments[0],
          context,
          'high',
          'js.new-url',
          'new URL(…, import.meta.url)',
        );
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
    case 'BinaryExpression':
      if (node.operator === '+') collectFromChain(node, context);
      return;
    default:
  }
}

/**
 * A path-shaped string literal that no construct above claimed, such as
 * `path: './_images/logo.png'` in an object literal. Emitted as a guess, as the JSON adapter
 * emits its strings: one that resolves becomes a link, and one that does not is discarded
 * and counted in the report. See "The six that exist" in ARCHITECTURE.md.
 */
function collectSpeculativeString(node: StringLiteral, context: Context): void {
  const candidate = speculativeStringPath(node, context.text);
  if (candidate === null) return;
  const { start, path } = candidate;

  context.speculative.push({
    file: context.file,
    start,
    end: start + path.length,
    rawPath: path,
    kind: 'string',
    // Not `path.bare-specifier`, even for a bare string. Inside `import` or `require()` a
    // bare string is module-resolution syntax, but in an ordinary string
    // `src/assets/hero.png` is a relative path written without `./`, and a prefix test
    // would call `v2.0.0` and `bs.button` packages. Telling `some-ui-kit/dist/x.png` from
    // `src/assets/x.png` needs to know what is installed, which an adapter cannot see, so
    // `path.bare-specifier` lists this shape in `adapterEmitsAs`.
    shape: 'js.string.literal',
    ceiling: 'high',
    asserted: false,
    note: 'a path-shaped string literal, guessed rather than asserted',
  });
}

/**
 * Where a string literal names a complete path on its own, or `null`.
 *
 * Shared with the chain reader, which leaves a `+` chain to any literal in it that is
 * already a complete path, so "complete path" means the same thing in both.
 */
function speculativeStringPath(
  node: StringLiteral,
  text: string,
): { readonly start: number; readonly path: string } | null {
  if (node.start === null || node.start === undefined) return null;
  if (node.end === null || node.end === undefined) return null;

  const start = node.start + 1;
  const raw = text.slice(start, node.end - 1);
  // An escaped string's decoded value differs in length from its text, so no range
  // would point at the path. A guess is not worth an unrewritable reference.
  if (raw !== node.value) return null;

  const { path } = splitPathSuffix(raw);
  // Anything with a file extension is a candidate, the same bound the JSON adapter uses.
  // Which extensions are assets is decided in one place, the resolver.
  if (path === '' || extensionOf(path) === '' || isExternalUrl(raw, 'string')) return null;
  if (!plausiblePathShape(path)) return null;
  return { start, path };
}

/**
 * A path-shaped template literal that no construct above claimed, emitted as a guess.
 *
 * Like any template it can carry a `medium` ceiling, so the resolver globs
 * `` `./_images/background-${dir}.png` `` and links every file it matches. No basename
 * sweep could find those files, because their names never appear in the source.
 */
function collectSpeculativeTemplate(node: TemplateLiteral, context: Context): void {
  if (node.start === null || node.start === undefined) return;
  if (context.handled.has(node.start)) return;
  if (!pathShaped(templateChunks(node, context).chunks)) return;

  addTemplateReference(
    node,
    context,
    'string',
    templateShape(node, context),
    'a path-shaped template literal',
    false,
  );
}

/**
 * Whether assembled static text looks like a path with a file extension: the bound on
 * every guess about a template or a `+` chain. `${x} items` is not a candidate.
 *
 * The extension must be in the static text. In `report.${type}` the hole is the
 * extension, and guessing there admits version strings and translation keys rather than
 * images. An asserting position such as `` <img src={`hero.${ext}`}> `` is not held to
 * this bound. For the shape test each hole is written `*`, which `plausiblePathShape`
 * accepts inside a path. See "Assembled paths in JavaScript" in ARCHITECTURE.md.
 */
function pathShaped(chunks: readonly string[]): boolean {
  return staticExtensionOf(chunks.join(HOLE)) !== '' && plausiblePathShape(chunks.join('*'));
}

/**
 * A template literal's static chunks (the text between its unknown segments), with every
 * hole a same-file constant fills written in.
 *
 * `traced` is whether any hole was filled, which is when the path the text proves differs
 * from the text itself, and so when a reference needs an `assembledPath`.
 */
function templateChunks(
  template: TemplateLiteral,
  context: Context,
): { readonly chunks: readonly string[]; readonly traced: boolean } {
  const chunks: string[] = [];
  let current = '';
  let traced = false;
  for (const [index, quasi] of template.quasis.entries()) {
    current += quasi.value.raw;
    const hole = template.expressions[index];
    if (hole === undefined) break;
    const value = hole.type === 'Identifier' ? context.constantNamed(hole.name) : null;
    if (value === null) {
      chunks.push(current);
      current = '';
    } else {
      current += value;
      traced = true;
    }
  }
  chunks.push(current);
  return { chunks, traced };
}

/**
 * A path assembled with `+`, read as its template twin is read:
 * `'/srcset/' + 'card-' + String(width) + '.jpg'` gets the same bound, globbing rule and
 * `addReference` tests as `` `/srcset/card-${width}.jpg` ``, all asked of the assembled text.
 *
 * Where one operand is already a complete path (`'/img/hero.jpg' + '?v=' + v`), that
 * literal stays the reference and the chain is not read, so a rewrite can still edit the
 * literal. A chain is a guess wherever it sits, a JSX `src` included. The range runs from
 * the first operand to the last without their outer quotes, so `rawPath` is source text,
 * and the assembled path travels as `assembledPath`. See "Assembled paths in JavaScript"
 * in ARCHITECTURE.md.
 */
function collectFromChain(node: BinaryExpression, context: Context): void {
  if (context.chainParts.has(node)) return;
  const operands = chainOperands(node, context.chainParts);
  if (operands.some((operand) => standsAlone(operand, context))) return;

  const chunks: string[] = [];
  let current = '';
  for (const operand of operands) {
    const value = operandText(operand, context);
    if (value === null) {
      chunks.push(current);
      current = '';
    } else {
      current += value;
    }
  }
  chunks.push(current);
  if (!pathShaped(chunks)) return;

  const first = operands[0];
  const last = operands[operands.length - 1];
  if (first?.start === null || first?.start === undefined) return;
  if (last?.end === null || last?.end === undefined) return;
  const start = first.start + (isQuoted(first) ? 1 : 0);
  const end = last.end - (isQuoted(last) ? 1 : 0);
  const globbable = assembledPathIsGlobbable(chunks);

  addReference({
    context,
    start,
    end,
    rawPath: context.text.slice(start, end),
    assembledPath: chunks.join(HOLE),
    kind: 'string',
    shape: globbable ? 'js.concat.pattern' : 'js.concat.dynamic',
    ceiling: globbable ? 'medium' : 'unsafe',
    note: globbable
      ? 'a path assembled with +, with a static prefix; the resolver decides which assets it names'
      : `a path assembled with +: ${NOT_GLOBBABLE_REASON}`,
    skipPathChecks: true,
    asserted: false,
  });
}

/**
 * How an unknown segment is written in an `assembledPath`. It must match one of
 * `INTERPOLATIONS`, which is how the resolver finds the unknown segments to glob.
 */
const HOLE = '${}';

/**
 * A chain's operands, left to right.
 *
 * `a + b + c` nests down its left side, so only that side is followed. A parenthesised
 * `+` is one operand, not more of the chain: in `'/img/' + (i + 1) + '.png'` the brackets
 * may be adding numbers.
 */
function chainOperands(node: BinaryExpression, parts: Set<BabelNode>): BabelNode[] {
  const operands: BabelNode[] = [node.right];
  let left: BabelNode = node.left;
  while (left.type === 'BinaryExpression' && left.operator === '+' && !isParenthesized(left)) {
    parts.add(left);
    operands.unshift(left.right);
    left = left.left;
  }
  operands.unshift(left);
  return operands;
}

function isParenthesized(node: BabelNode): boolean {
  return (node.extra as { parenthesized?: unknown } | undefined)?.parenthesized === true;
}

/** Whether an operand is, by itself, a path one of the other rules already reads. */
function standsAlone(operand: BabelNode, context: Context): boolean {
  if (operand.type === 'StringLiteral') {
    return speculativeStringPath(operand, context.text) !== null;
  }
  return operand.type === 'TemplateLiteral' && pathShaped(templateChunks(operand, context).chunks);
}

/**
 * What an operand contributes to the path's static text, or `null` for an unknown.
 *
 * A template with holes is one unknown here. The template rule reads it on its own, and
 * splitting it again inside the chain could only make the chain more globbable than its
 * template twin.
 */
function operandText(operand: BabelNode, context: Context): string | null {
  if (operand.type === 'StringLiteral') return operand.value;
  if (operand.type === 'TemplateLiteral') {
    return operand.expressions.length === 0
      ? operand.quasis.map((quasi) => quasi.value.raw).join('')
      : null;
  }
  return operand.type === 'Identifier' ? context.constantNamed(operand.name) : null;
}

function isQuoted(node: BabelNode): boolean {
  return node.type === 'StringLiteral' || node.type === 'TemplateLiteral';
}

/**
 * Same-file string constants a path may be read through, looked up on first use:
 * `const ASSET_BASE = '/gallery'` makes `` `${ASSET_BASE}/${name}.png` `` a pattern.
 *
 * A name is read only if it has exactly one binding anywhere in the file and that binding
 * is a top-level `const` initialised with a string. A top-level binding is visible
 * throughout the module, so with no other binding every use of the name is that constant,
 * and no scope analysis is needed. `let` and `var` are never read: their first value
 * proves nothing about a later use. See "Assembled paths in JavaScript" in ARCHITECTURE.md.
 *
 * Both lookups are lazy, because most files never ask: the top-level scan runs only when a
 * hole or operand is an identifier, the binding count only when it names such a constant.
 */
function sameFileConstants(program: Program): (name: string) => string | null {
  let declared: ReadonlyMap<string, string> | undefined;
  let bindings: ReadonlyMap<string, number> | undefined;
  return (name) => {
    declared ??= topLevelStringConstants(program);
    const value = declared.get(name);
    if (value === undefined) return null;
    bindings ??= bindingCounts(program);
    return bindings.get(name) === 1 ? value : null;
  };
}

function topLevelStringConstants(program: Program): ReadonlyMap<string, string> {
  const constants = new Map<string, string>();
  for (const statement of program.body) {
    const declaration =
      statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'const') continue;
    for (const { id, init } of declaration.declarations) {
      if (id.type === 'Identifier' && init?.type === 'StringLiteral') {
        constants.set(id.name, init.value);
      }
    }
  }
  return constants;
}

/**
 * How many times each name is bound anywhere in the file.
 *
 * Over-counting can only refuse a trace, so bindings in every scope count. Imports are not
 * visited: an imported name cannot also be a top-level `const`, which the parser rejects
 * as a redeclaration.
 */
function bindingCounts(program: Program): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  walk(program, (node) => {
    for (const name of boundNames(node)) counts.set(name, (counts.get(name) ?? 0) + 1);
  });
  return counts;
}

function boundNames(node: BabelNode): readonly string[] {
  switch (node.type) {
    case 'VariableDeclarator':
      return patternNames(node.id);
    case 'CatchClause':
      return node.param === null || node.param === undefined ? [] : patternNames(node.param);
    case 'ClassDeclaration':
    case 'ClassExpression':
      return node.id === null || node.id === undefined ? [] : [node.id.name];
    case 'FunctionDeclaration':
    case 'FunctionExpression':
      return [
        ...(node.id === null || node.id === undefined ? [] : [node.id.name]),
        ...node.params.flatMap(patternNames),
      ];
    case 'ArrowFunctionExpression':
    case 'ObjectMethod':
    case 'ClassMethod':
    case 'ClassPrivateMethod':
      return node.params.flatMap(patternNames);
    default:
      return [];
  }
}

/** The names a declaration pattern or a parameter binds. */
function patternNames(pattern: BabelNode): readonly string[] {
  switch (pattern.type) {
    case 'Identifier':
      return [pattern.name];
    case 'ObjectPattern':
      return pattern.properties.flatMap((property) =>
        patternNames(property.type === 'RestElement' ? property.argument : property.value),
      );
    case 'ArrayPattern':
      return pattern.elements.flatMap((element) => (element === null ? [] : patternNames(element)));
    case 'AssignmentPattern':
      return patternNames(pattern.left);
    case 'RestElement':
      return patternNames(pattern.argument);
    case 'TSParameterProperty':
      return patternNames(pattern.parameter);
    default:
      return [];
  }
}

function collectFromImportDeclaration(node: ImportDeclaration, context: Context): void {
  // `import type { X } from './x'` is erased at compile time and never loads a file.
  if (node.importKind === 'type') return;
  collectFromModuleSource(
    node.source,
    context,
    'certain',
    moduleSourceShape(node.source, 'js.import.static'),
    'static import',
  );
}

function collectFromImportExpression(node: ImportExpression, context: Context): void {
  collectFromModuleSource(
    node.source,
    context,
    'certain',
    moduleSourceShape(node.source, 'js.import.dynamic'),
    'dynamic import()',
  );
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

  // Every string attribute value is recorded as examined, including the ones declined
  // below: `alt="/not.png"` is display text, and the speculative string rule would
  // otherwise link and rewrite it.
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

  addJsxAttributeValue(
    value,
    context,
    isSrcSet ? 'js.jsx.srcset' : 'js.jsx.attribute',
    `JSX ${name}`,
    isSrcSet,
  );
}

/**
 * Emit a reference for a JSX attribute value, whatever shape it takes.
 *
 * Shared by the `src`/`srcSet`/`poster` reader and the inline-SVG `href` reader, so both
 * read every kind of value the same way.
 */
function addJsxAttributeValue(
  value: JSXAttribute['value'],
  context: Context,
  shape: ShapeId,
  label: string,
  isSrcSet: boolean,
): void {
  if (value === null || value === undefined) return;

  if (value.type === 'StringLiteral') {
    addLiteralReference(value, context, 'high', 'attr', shape, label, isSrcSet);
    return;
  }

  if (value.type === 'JSXExpressionContainer') {
    const expression = value.expression;
    if (expression.type === 'StringLiteral') {
      addLiteralReference(expression, context, 'high', 'attr', shape, label, isSrcSet);
      return;
    }
    if (expression.type === 'TemplateLiteral') {
      addTemplateReference(expression, context, 'attr', templateShape(expression, context), label);
    }
    // Anything else (an identifier, a call, a conditional) is not read as a path here.
    // Literals inside it still reach the speculative rules, and an import behind it is
    // read on its own.
  }
}

/** The attribute's written name, including a namespace such as `xlink:href`. */
function jsxAttributeName(attribute: JSXAttribute): string {
  const name = attribute.name;
  if (name.type === 'JSXIdentifier') return name.name;
  return `${name.namespace.name}:${name.name.name}`;
}

/**
 * `<image href>` and `<feImage href>` inside JSX, read at the element because `href`
 * alone does not say whether it names a file. An inline `<svg>` in a component is not an
 * `.svg` file, so an SVG adapter would never reach these.
 */
function collectFromJsxSvgImage(node: JSXOpeningElement, context: Context): void {
  const tag = node.name.type === 'JSXIdentifier' ? node.name.name.toLowerCase() : '';
  const attributes = JSX_SVG_HREF_ELEMENTS.get(tag);
  if (attributes === undefined) return;

  for (const attribute of node.attributes) {
    if (attribute.type !== 'JSXAttribute') continue;
    if (!attributes.includes(jsxAttributeName(attribute).toLowerCase())) continue;
    addJsxAttributeValue(attribute.value, context, 'js.jsx.svg', `JSX <${tag}> href`, false);
  }
}

/** Handle an import/require/URL argument, which may be a string or a template. */
function collectFromModuleSource(
  source: BabelNode | null | undefined,
  context: Context,
  ceiling: Confidence,
  shape: ShapeId,
  description: string,
): void {
  if (source === null || source === undefined) return;
  if (source.type === 'StringLiteral') {
    addLiteralReference(source, context, ceiling, 'import', shape, description);
    return;
  }
  if (source.type === 'TemplateLiteral') {
    addTemplateReference(source, context, 'import', shape, description);
  }
}

function collectFromTaggedTemplate(node: TaggedTemplateExpression, context: Context): void {
  // Claimed whatever the tag, CSS or not: the body is the tag's input, not a path.
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
        // SCSS rather than plain CSS, because styled-components nest rules as SCSS does.
        extension: '.scss',
        // The host shape wins over the dialect: what would break these is the template
        // flattening, not SCSS parsing.
        hostShape: 'js.cssinjs',
      }).map((reference) => withInterpolationRestored(reference, context.text)),
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
      shape: 'js.cssinjs',
      ceiling: 'unsafe',
      asserted: false,
      note: 'CSS-in-JS template could not be parsed as CSS, so it was left alone',
    });
  }
}

/**
 * Give a CSS-in-JS `url()` back the path the file holds, and let the shared glob rule
 * decide what an interpolated one is.
 *
 * The CSS pass reads the flattened template, where each `${…}` is a comment, and calls
 * such a `url()` dynamic. Only this adapter knows which comments are its own placeholders,
 * so it puts the source text back as `rawPath` whether or not the path globs: that keeps
 * `source.slice(start, end) === rawPath` and lets the resolver read the `${…}`. It then
 * asks `assembledPathIsGlobbable`, as for every template literal in the file.
 */
function withInterpolationRestored(reference: RawReference, text: string): RawReference {
  const source = text.slice(reference.start, reference.end);
  if (source === reference.rawPath) return reference;

  const restored = { ...reference, rawPath: source };
  const chunks = interpolationChunks(source);
  if (chunks.length < 2 || !assembledPathIsGlobbable(chunks)) return restored;
  return {
    ...restored,
    // Shaped as a template pattern: the glob rule is what can fail here, as for any
    // template literal in the file.
    shape: 'js.template.pattern',
    ceiling: 'medium',
    note: 'CSS-in-JS url() with a static prefix; the resolver decides whether it names exactly one asset',
  };
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
 * Turn a template literal into one run of text whose offsets still line up with the file.
 *
 * Every `${…}` becomes a CSS comment of the same length, so the CSS stays parseable and
 * every offset after it is unchanged. The shortest expression, `${x}`, is four characters,
 * and so is the shortest comment, so nothing ever has to shrink. A comment rather than a
 * SCSS interpolation, because a mixin such as `${baseStyles}` at statement level is common
 * and `#{…}` fails to parse there. The CSS adapter treats a `url()` holding `/*` as
 * dynamic, so an interpolated path is never taken for a literal one, and
 * `withInterpolationRestored` then decides whether it globs. See "The six that exist" in
 * ARCHITECTURE.md.
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

/**
 * The shape of a module specifier: `path.bare-specifier` for a package, otherwise the
 * construct it was written in.
 *
 * It cannot tell a mapped alias from an unmapped one: whether `~/img/hero.png` resolves
 * depends on the `tsconfig` paths table, which only the resolver has. Both alias shapes
 * list the construct shapes in `adapterEmitsAs` instead.
 */
function moduleSourceShape(source: BabelNode | null | undefined, construct: ShapeId): ShapeId {
  const value =
    source !== null && source !== undefined && source.type === 'StringLiteral' ? source.value : '';
  return isBareSpecifier(value) ? 'path.bare-specifier' : construct;
}

/**
 * Whether a module specifier names a package rather than a file in this project.
 *
 * This beats the construct: `some-ui-kit/dist/logo.png` is a file inside a dependency, out
 * of scope and not ours to rewrite, whether it was imported or required. `@` stays
 * alias-shaped, because `@scope/pkg/x.png` and an `@img/*` tsconfig alias are the same
 * syntax and only the resolver has the table that separates them. It is not applied to
 * `new URL(x, import.meta.url)`, where a bare `'img.png'` is relative to the module.
 */
function isBareSpecifier(value: string): boolean {
  if (value === '') return false;
  // Relative or root-relative: an ordinary reference to a file in this project.
  if (value.startsWith('.') || value.startsWith('/')) return false;
  // Alias-shaped: which alias it is depends on a table only the resolver has.
  if (value.startsWith('~') || value.startsWith('@') || value.startsWith('#')) return false;
  return true;
}

/**
 * The shape of a template literal: `js.template.pattern` while `assembledPathIsGlobbable`
 * accepts it, `js.template.dynamic` otherwise.
 *
 * A pattern needs a fixed directory before its first unknown segment, because location is
 * what makes an asset unique, and at most one unknown segment in the file name, or the glob
 * sweeps in strangers. `/theme-${mode}.png` is a pattern; `${base}/hero.png` and
 * `/icons/${theme}-${size}.png` are dynamic. Only the file name's unknowns count, so
 * `/img/${dir}/${name}.png` is a pattern.
 */
function templateShape(template: TemplateLiteral, context: Context): ShapeId {
  return assembledPathIsGlobbable(templateChunks(template, context).chunks)
    ? 'js.template.pattern'
    : 'js.template.dynamic';
}

function addLiteralReference(
  literal: StringLiteral,
  context: Context,
  ceiling: Confidence,
  kind: ReferenceKind,
  shape: ShapeId,
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
      shape,
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
        shape,
        ceiling,
        note: description,
      });
    }
    return;
  }

  addReference({ context, start, end, rawPath: raw, kind, shape, ceiling, note: description });
}

/**
 * A template literal used as a path.
 *
 * With no expressions it is just a string. With expressions it is `medium` when
 * `assembledPathIsGlobbable` accepts it, so the resolver globs it and links every match,
 * and `unsafe` otherwise. A template that matches nothing is `dynamic`, never `broken`:
 * nobody typed a path that points at nothing.
 */
function addTemplateReference(
  template: TemplateLiteral,
  context: Context,
  kind: ReferenceKind,
  shape: ShapeId,
  description: string,
  asserted = true,
): void {
  const flattened = flattenTemplate(template, context.text);
  if (flattened === null) return;

  const hasExpressions = template.expressions.length > 0;
  const raw = context.text.slice(flattened.start, flattened.start + flattened.text.length);
  // The ceiling is what the resolver reads: it globs `medium`, refuses `unsafe`, and never
  // looks at `shape`. So the glob rule has to set the ceiling here; `templateShape` alone
  // would change only the label. The chunks are the traced ones, so
  // `${ASSET_BASE}/${name}.png` is judged as the `/gallery/${name}.png` the text proves,
  // and that path travels as `assembledPath` because `rawPath` must stay the source text.
  const { chunks, traced } = templateChunks(template, context);
  const globbable = hasExpressions && assembledPathIsGlobbable(chunks);

  addReference({
    context,
    start: flattened.start,
    end: flattened.start + raw.length,
    rawPath: raw,
    ...(traced ? { assembledPath: chunks.join(HOLE) } : {}),
    kind,
    shape,
    ceiling: globbable ? 'medium' : hasExpressions ? 'unsafe' : 'high',
    note: globbable
      ? `${description}: a template literal with a static prefix; the resolver decides whether it names exactly one asset`
      : hasExpressions
        ? `${description}: ${NOT_GLOBBABLE_REASON}`
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
  /**
   * What the text proves the path is, when that is not `rawPath` itself: a `+` chain, or a
   * template with a same-file constant written in. Every test below that asks what the
   * path is reads this; the range stays on `rawPath`.
   */
  assembledPath?: string;
  kind: ReferenceKind;
  shape: ShapeId;
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
    assembledPath,
    kind,
    shape,
    ceiling,
    note,
    skipPathChecks = false,
    asserted = true,
  } = input;
  if (rawPath === '') return;
  const into = asserted ? context.references : context.speculative;
  const provenPath = assembledPath ?? rawPath;

  // Above the `skipPathChecks` branch, which means only that suffix splitting would be
  // wrong on this text. A URL is external whatever its holes hold: `https://${branch}.x.com/`
  // is hosted elsewhere, while `${base}/hero.png` starts with a hole, not a scheme. Asked
  // of the assembled path, so `CDN + '/hero.png'` with `const CDN = 'https://…'` is external.
  if (isExternalUrl(provenPath, kind)) return;

  // Beside the external-URL test for the same reason: a path that ends in `/` names a
  // directory whether or not its middle is a hole.
  if (provablyNotAFile(provenPath) !== null) return;

  if (skipPathChecks) {
    into.push({
      file: context.file,
      start,
      end: input.end,
      rawPath,
      ...(assembledPath === undefined ? {} : { assembledPath }),
      kind,
      shape,
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
    // suffix, which in a Vite project changes what the import returns.
    end: start + path.length,
    rawPath: path,
    kind,
    shape,
    ceiling,
    asserted,
    note: suffix === '' ? note : `${note}; query or fragment preserved: ${suffix}`,
  });
}
