/** The preview card with a version query, so a crawler fetches the picture again after it changes. */
export function PreviewVersion({ version }: { version: string }) {
  return <meta name="twitter:image" content={'/img/banner.png' + '?v=' + version} />;
}
