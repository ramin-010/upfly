/** The banner as the link preview when the page is wide enough for it, the hero otherwise. */
export function PreviewChoice({ wide }: { wide: boolean }) {
  return <meta property="og:image" content={wide ? '/img/banner.png' : '/img/hero.jpg'} />;
}
