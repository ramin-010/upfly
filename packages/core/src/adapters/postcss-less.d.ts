/**
 * `postcss-less` ships no type declarations, and there is no `@types` package for
 * its current major. Rather than let it come through as `any` — which rule 1 forbids
 * and which would silently erase the `Root` type at the call site — we declare the
 * one export the CSS adapter uses, with PostCSS's own types.
 *
 * `postcss-scss` needs no equivalent: it bundles its own declarations.
 */
declare module 'postcss-less' {
  import type { Parser, Root } from 'postcss';

  const parser: {
    readonly parse: Parser<Root>;
  };

  export default parser;
}
