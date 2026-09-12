# Fixture image credits

Every photograph in these fixtures is in the **public domain**. Both sources are works of
NASA, which are not subject to copyright in the United States.

They are here because the fixtures previously held 70-byte placeholder images that WebP
makes *larger*, so `optimize` was a no-op on three of the five and the exit criterion
**could not fail** (R53). A test that cannot fail is not a test.

Only paths that were already referenced were replaced, and no new reference was added, so
the negative-control calibration in `bench/src/fixture-build.ts` is unaffected. The
unreferenced placeholders (`never-used.png`, `orphan.png`, `unreferenced.png` and friends)
are deliberately left as they were: they exist to be found by the dead-asset rules, where
their contents do not matter.

## Sources

| | |
|---|---|
| **Earthrise** | NASA / Bill Anders, Apollo 8, 24 December 1968 |
| Source | https://commons.wikimedia.org/wiki/File:NASA-Apollo8-Dec24-Earthrise.jpg |
| Licence | Public domain (`PD-USGov-NASA`) |
| | |
| **The Blue Marble** | NASA / Apollo 17 crew (Harrison Schmitt or Ron Evans), 7 December 1972 |
| Source | https://commons.wikimedia.org/wiki/File:The_Earth_seen_from_Apollo_17.jpg |
| Licence | Public domain (`PD-USGov-NASA`) |

Licences were read from the Commons API rather than assumed. A third candidate, a
photograph of a cat, was discarded on checking: it is CC BY-SA 3.0, and these fixtures ship
publicly in Phase 3.

## How each file was produced

From the full-resolution original, centre-cropped to the listed size with
`sharp(...).resize(w, h, { fit: 'cover' })`, then written as PNG at compression level 9 or
JPEG at quality 82. No metadata is carried over: an EXIF block would be bytes the engine
cannot improve, and it would make the saving figures describe the wrong thing.

| fixture | file | source | size |
|---|---|---|---|
| `astro` | `src/assets/logo.png` | Earthrise | 160x120 |
| `astro` | `src/assets/chart.png` | Blue Marble | 200x150 |
| `astro` | `public/banner.png` | Earthrise | 200x120 |
| `next-app` | `public/hero.png` | Blue Marble | 200x150 |
| `next-app` | `public/hero@2x.png` | Blue Marble | 320x240 |
| `next-app` | `public/inline-mdx.png` | Earthrise | 200x150 |
| `next-app` | `public/diagram.png` | Blue Marble | 200x150 |
| `eleventy` | `src/img/hero.jpg` | Blue Marble | 240x160 |
| `eleventy` | `src/img/logo.png` | Earthrise | 160x120 |
| `eleventy` | `src/img/diagram.png` | Blue Marble | 200x150 |
| `vite-react` | `src/assets/logo.png` | Earthrise | 160x120 |
| `vite-react` | `src/assets/banner.png` | Blue Marble | 200x120 |
| `vite-react` | `src/assets/hero.jpg` | Earthrise | 240x160 |
| `vite-react` | `public/photos/wide.jpg` | Blue Marble | 240x120 |
| `vite-react` | `public/photos/wide@2x.jpg` | Blue Marble | 480x240 |
| `vite-react` | `public/screenshot.png` | Earthrise | 200x150 |
| `plain-html` | `images/logo.png` | Earthrise | 160x120 |
| `plain-html` | `images/inline.png` | Blue Marble | 200x150 |
| `plain-html` | `images/hero.jpg` | Blue Marble | 240x160 |
| `plain-html` | `images/hero@2x.jpg` | Blue Marble | 480x320 |
| `plain-html` | `images/team.jpg` | Earthrise | 240x160 |
| `plain-html` | `images/texture.png` | Earthrise | 160x160 |
