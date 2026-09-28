/** A picture whose tooltip names the banner it was cropped from. */
export function PhotoTitle({ src }: { src: string }) {
  return <img src={src} title="/img/banner.png" />;
}
