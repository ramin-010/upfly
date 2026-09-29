# Accuracy suite image credits

Every photograph in this tree is in the public domain, and every licence was read from the
Wikimedia Commons API rather than assumed, by the method recorded in
[`../fixtures/IMAGE-CREDITS.md`](../fixtures/IMAGE-CREDITS.md), which this follows exactly.

## Sources

| | |
|---|---|
| Earthrise | NASA / Bill Anders, Apollo 8, 24 December 1968 |
| Source | https://commons.wikimedia.org/wiki/File:NASA-Apollo8-Dec24-Earthrise.jpg |
| Licence | `Public domain` (`pd`), artist `NASA/Bill Anders`, no restrictions |
| | |
| The Blue Marble | NASA / Apollo 17 crew (Harrison Schmitt or Ron Evans), 7 December 1972 |
| Source | https://commons.wikimedia.org/wiki/File:The_Earth_seen_from_Apollo_17.jpg |
| Licence | `Public domain` (`pd`), no restrictions |
| | |
| Migrant Mother | Dorothea Lange, 1936. Library of Congress, Prints and Photographs Division |
| Source | https://commons.wikimedia.org/wiki/File:Migrant_Mother_(LOC_fsa.8b29516).jpg |
| Licence | `Public domain` (`pd`), no restrictions |
| | |
| Solvay Conference 1927 | Benjamin Couprie, Institut International de Physique Solvay |
| Source | https://commons.wikimedia.org/wiki/File:Solvay_conference_1927.jpg |
| Licence | `Public domain` (`pd`), no restrictions |

Four sources rather than two, chosen for different compression behaviour: one colour
photograph that is mostly black (Earthrise), one that is mostly bright (Blue Marble), one
monochrome portrait with heavy film grain (Migrant Mother) and one monochrome group
photograph dense with fine detail (Solvay). A tree built from one source would measure one
kind of image.

## Two candidates were discarded on checking

Both were wanted for texture and landscape variety, and both failed at the licence step:

| candidate | why it was discarded |
|---|---|
| `File:Hopetoun_falls.jpg` | CC BY-SA 3.0, not public domain |
| `File:Brick_wall_close-up_view.jpg` | CC BY-SA 3.0, not public domain |

They are recorded here for the same reason the cat photograph is recorded in the fixtures'
credits: the method is only worth anything if it is applied before a file is used, and the
evidence that it was applied is a rejection.

## How each file was produced

Centre-cropped from the source with `sharp(...).resize(w, h, { fit: 'cover' })`, then written
as PNG at compression level 9 or JPEG at quality 82, with no metadata carried over. Identical
to the fixtures' recipe, so the two image sets compress alike and a measurement on one carries
to the other.

Sources were fetched at `width=2400` through `Special:FilePath`, because two of the four
originals are over 20 MB.

The full table of 74 photographs (path, source, dimensions, byte size and hash) is in
[`key/answer-key.json`](key/answer-key.json) under `assets`, and the self-check verifies
every size and hash against the file on disk. It is not duplicated here, because a table
maintained in two places is a table that disagrees with itself.

## Five files are not photographs, and say so

`clip.mp4`, `trailer.mp4`, `theme.mp3`, `spec-sheet.pdf` and `placeholder.woff2` are stubs
carrying only correct magic bytes. They exist to be resolution targets: a `<video src>`
pointing at a real file the engine does not index is `out-of-scope`, and that outcome needs
the file to actually be there. They are never encode inputs, and the key marks each
`"source": "stub"`.

`mask.svg` and `icon.svg` are hand-written vectors. An `svg` is what a `rel="icon"` points at
in real projects, and it is not a photograph in anybody's telling.

## Why no image here grows when converted to WebP

An early requirement asked for a few images small enough that WebP makes them larger. No
real photograph does that, so the requirement was withdrawn on 2026-09-13 on the strength of
this measurement: across all four sources at fourteen sizes from 128×96 down to 8×8, 56
combinations, WebP was smaller than PNG in every one, lossless and lossy alike. At 8×8,
Earthrise is 179 bytes as PNG, 130 as lossless WebP and 76 at quality 80.

The property belongs to synthetic placeholders: `fixtures/partial-pattern/theme-dark.png` is
70 bytes as PNG and 94 as WebP, which is why that fixture must not be replaced with a
photograph. This tree must not use placeholders, since it measures real images, so no one
file could serve both needs.

So the work is divided: `fixtures/partial-pattern` is a conversion fixture and already carries
that property; this tree measures reference detection. Every asset here still records its
real byte size and hash, so probe and encode coverage can be added later without rebuilding
the tree. Nothing was faked to close the gap while it was open.
