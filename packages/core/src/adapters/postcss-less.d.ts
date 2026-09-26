/**
 * Types for `postcss-less`, which ships none and has no `@types` package for its current
 * major. Declaring the one export the CSS adapter uses, with PostCSS's own types, keeps
 * `Root` typed at the call site instead of `any`. `postcss-scss` bundles its own.
 */
declare module 'postcss-less' {
  import type { Parser, Root } from 'postcss';

  const parser: {
    readonly parse: Parser<Root>;
  };

  export default parser;
}
