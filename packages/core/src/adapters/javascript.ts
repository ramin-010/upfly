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
  StringLiteral,
  TaggedTemplateExpression,
  TemplateLiteral,
} from '@babel/types';
import { applyEdits } from '../edits.js';
import { UpflyError } from '../errors.js';
import { extensionOf } from '../paths.js';
import type { Adapter, Confidence, RawReference, ReferenceKind } from '../types.js';
import { findCssReferences } from './css.js';
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

export const javascriptAdapter: Adapter = {
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
      throw new UpflyError(
        'ADAPTER_PARSE_FAILED',
        `Could not parse ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const context: Context = { file, text, references: [] };
    walk(ast, (node) => collectFromNode(node, context));
    return context.references.sort((a, b) => a.start - b.start);
  },

  rewrite({ text, edits }): string {
    return applyEdits(text, edits);
  },
};

interface Context {
  readonly file: string;
  readonly text: string;
  readonly references: RawReference[];
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
    case 'JSXAttribute':
      collectFromJsxAttribute(node, context);
      return;
    case 'TaggedTemplateExpression':
      collectFromTaggedTemplate(node, context);
      return;
    default:
  }
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
  const name = node.name.type === 'JSXIdentifier' ? node.name.name : '';
  if (!JSX_URL_ATTRIBUTES.has(name.toLowerCase())) return;

  const value = node.value;
  if (value === null || value === undefined) return;

  // `srcSet` holds a candidate list, not a path. Left unsplit it produces two false
  // positives at once: the whole string resolves to nothing, and every image in it
  // but the first gains no reference and looks dead.
  const isSrcSet = name.toLowerCase() === 'srcset';

  if (value.type === 'StringLiteral') {
    addLiteralReference(value, context, 'high', 'attr', `JSX ${name}`, isSrcSet);
    return;
  }

  if (value.type === 'JSXExpressionContainer') {
    const expression = value.expression;
    if (expression.type === 'StringLiteral') {
      addLiteralReference(expression, context, 'high', 'attr', `JSX ${name}`, isSrcSet);
      return;
    }
    if (expression.type === 'TemplateLiteral') {
      addTemplateReference(expression, context, 'attr', `JSX ${name}`);
    }
    // Anything else — an identifier, a call, a conditional — is a value, not a
    // path. The import that produced it was already captured on its own.
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
}): void {
  const { context, start, rawPath, kind, ceiling, note, skipPathChecks = false } = input;
  if (rawPath === '') return;

  if (skipPathChecks) {
    context.references.push({
      file: context.file,
      start,
      end: input.end,
      rawPath,
      kind,
      ceiling,
      asserted: true,
      note,
    });
    return;
  }

  if (isExternalUrl(rawPath)) return;

  const { path, suffix } = splitPathSuffix(rawPath);
  if (path === '') return;

  context.references.push({
    file: context.file,
    start,
    // The range covers the path alone, so a rewrite preserves any `?raw` or `?v=2`
    // suffix — which in a Vite project changes what the import actually returns.
    end: start + path.length,
    rawPath: path,
    kind,
    ceiling,
    asserted: true,
    note: suffix === '' ? note : `${note}; query or fragment preserved: ${suffix}`,
  });
}
