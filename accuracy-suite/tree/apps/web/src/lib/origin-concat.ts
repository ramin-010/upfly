/**
 * The share image as a full address on the live site. The path is the end of that address,
 * joined after an origin this file does not know, so it names no file here.
 */
export function shareImage(liveSite: string): string {
  return liveSite + '/img/team.jpg';
}

/** The same, joined from a template with nothing to fill in. */
export function bannerImage(liveSite: string): string {
  return liveSite + `/img/banner.png`;
}
