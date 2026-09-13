---
title: Getting started
description: The first page of the guide.
image: /img/hero.jpg
cover: /img/diagram.png
thumbnail: ../../../public/img/avatar.png
socialCard:
  url: /brand.png
  alt: The docs brand mark
tags:
  - guide
  - intro
---

# Getting started

![The hero](/img/hero.jpg)

![The diagram](/img/diagram.png "A diagram, with a title attribute")

![A logo, relative to this file](../../../public/logo.png)

![A shared asset, five levels up](../../../../../shared/assets/img/logo.png)

![Deliberately missing](/img/missing-from-markdown.png)

Reference-style links, whose definitions sit at the bottom of the file:

![The screenshot][shot]

![The avatar][avatar]

![One that was never defined][undefined-label]

Raw HTML inside the markdown, which the markdown parser hands through untouched:

<figure>
  <img src="/img/screenshot.png" alt="Screenshot, in raw HTML" width="640" height="480" />
  <img src="../../../public/img/avatar.png" alt="Avatar, in raw HTML" />
  <figcaption>Raw HTML is still HTML.</figcaption>
</figure>

<p style="background-image: url('/brand.png')">A style attribute inside markdown.</p>

## Prose, which is not a reference

The hero image lives at /img/hero.jpg and is 800 by 600. If you replace it, remember that
docs/public/img/diagram.png is generated rather than drawn, so editing it by hand is
wasted work. The file logo.png appears in six directories in this repository and they are
all different pictures.

## A fenced block, which is also not a reference

```html
<img src="/img/hero.jpg" alt="An example, not a reference" />
<img src="/gallery/photo.png" alt="Nor this one" />
```

```css
.example {
  background-image: url('/img/banner.png');
}
```

    An indented code block, which is a code block too:
    <img src="/img/team.jpg" alt="Indented, not a reference" />

Inline code, `<img src="/img/texture.png">`, is not a reference either.

[shot]: /img/screenshot.png
[avatar]: ../../../public/img/avatar.png
