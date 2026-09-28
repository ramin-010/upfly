/** A module-level prefix that is reassigned later, so its first value proves nothing about a call. */
let base = '/gallery';

export function setBase(next: string): void {
  base = next;
}

export function fromLetBase(name: string): string {
  return base + '/' + name + '.png';
}

export function fromLetBaseTemplate(name: string): string {
  return `${base}/${name}.png`;
}
