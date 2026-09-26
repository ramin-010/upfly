/** A thumbnail whose tooltip names the photo it shows, as a picker in an editor does. */
export function TeamThumb({ src, name }: { src: string; name: string }) {
  return <img src={src} title={`/img/team.jpg`} alt={`/srcset/${name}.jpg`} />;
}
