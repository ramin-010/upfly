/**
 * A link opening the poster at full size. The closing quote sits on the line below the
 * address, so the value ends with a line break, which a browser strips from a link.
 */
export function PosterLink() {
  return (
    <a
      className="poster-link"
      href="/media/poster.jpg
"
    >
      Full size
    </a>
  );
}
