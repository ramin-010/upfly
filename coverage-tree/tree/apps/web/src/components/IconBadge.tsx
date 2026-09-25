/** An app icon at one of the two sizes the manifest lists, joined with + inside the attribute. */
export function IconBadge({ size }: { size: 192 | 512 }) {
  return <img src={'/icons/icon-' + size + '.png'} alt="" width={size} height={size} />;
}
