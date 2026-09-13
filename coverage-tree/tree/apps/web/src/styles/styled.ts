/** CSS carried inside a template literal, which is CSS the CSS adapter never sees. */

const css = (strings: TemplateStringsArray, ...values: readonly string[]): string =>
  strings.reduce((out, part, i) => out + part + (values[i] ?? ''), '');

export const Masthead = css`
  background-image: url('/img/banner.png');
  background-size: cover;
`;

export const Crest = css`
  background-image: url("/gallery/photo.png");
  &::after {
    background-image: url(/srcset/tile.png);
  }
`;

export const Deep = css`
  background-image: url('../../../../shared/assets/img/hero.jpg');
`;

/**
 * One `..` short of the file it means. An off-by-one in a relative climb is the failure
 * `relocate` re-derives its way into, and it is indistinguishable from a typo unless the
 * engine reports it.
 */
export const OffByOne = css`
  background-image: url('../../../shared/assets/img/hero.jpg');
`;

export const Broken = css`
  background-image: url('/img/missing-from-styled.png');
`;

export const Remote = css`
  background-image: url('https://cdn.example.com/remote/styled.png');
`;

/** An interpolated value inside the CSS, which nothing can resolve statically. */
export function themed(mode: string): string {
  return css`
    background-image: url('/theme-${mode}.png');
  `;
}
