const SITE = 'https://example.com';

/** Hands over the team photo at its full address, for readers who share the file itself. */
export function ShareLink() {
  return (
    <a href={new URL('/img/team.jpg', SITE).href} download>
      Download the team photo
    </a>
  );
}
