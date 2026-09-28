/**
 * The team photo, with a space typed after the opening quote. A browser strips the
 * whitespace around an address before loading it.
 */
export function TeamPhoto() {
  return <img alt="Our team" src=" /img/team.jpg" />;
}
