/** CSS in a template literal whose url() has two unknowns side by side in the name. */

const css = (strings: TemplateStringsArray, ...values: readonly string[]): string =>
  strings.reduce((out, part, i) => out + part + (values[i] ?? ''), '');

/** A theme and a pixel-density suffix: two unknowns in one name is a guess, not a pattern. */
export function themedAt(mode: string, density: string): string {
  return css`
    background-image: url('/theme-${mode}${density}.png');
  `;
}
