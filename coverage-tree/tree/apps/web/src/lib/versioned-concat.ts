/** A cache-buster added with +. The whole path is still one literal, and that literal is the reference. */
export function versionedHero(version: string): string {
  return '/img/hero.jpg' + '?v=' + version;
}
