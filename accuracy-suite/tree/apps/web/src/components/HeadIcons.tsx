/** The icons a browser tab and a phone's home screen show, written into the page head. */
export function HeadIcons() {
  return (
    <>
      <link rel="apple-touch-icon" sizes="192x192" href="/icons/icon-192.png" />
      <link rel="shortcut icon" href={'/favicon.png'} />
    </>
  );
}
