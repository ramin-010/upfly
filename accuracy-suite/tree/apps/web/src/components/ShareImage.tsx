const SITE = 'https://example.com';

/** Crawlers that build link previews read an absolute address, so paths are made one here. */
function absolute(path: string): string {
  return new URL(path, SITE).href;
}

/** The picture a link preview shows, its address built by the helper above. */
export function ShareImage() {
  return <meta property="og:image" content={absolute('/img/banner.png')} />;
}
