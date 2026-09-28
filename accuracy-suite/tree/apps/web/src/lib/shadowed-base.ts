/** A module constant and a parameter with the same name. Inside the functions, the parameter wins. */
const BASE = '/gallery';

export function fromBase(BASE: string, name: string): string {
  return BASE + '/' + name + '.png';
}

export function fromBaseTemplate(BASE: string, name: string): string {
  return `${BASE}/${name}.png`;
}

export const DEFAULT_BASE = BASE;
