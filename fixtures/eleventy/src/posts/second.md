---
title: Reading the diagram
---

Eleventy copies `src/img` straight through to `/img`, so every path on this site is
written from the site root rather than relative to the page that uses it.

![The diagram, in context](/img/diagram.png)

<figure>
  <img src="/img/inline.png" srcset="/img/inline.png 1x, /img/diagram.png 2x" alt="The same panel at two densities" />
  <figcaption>Asked for twice, at two densities.</figcaption>
</figure>

The screenshot that belongs here was never added to the repository, and the name says so:

![A screenshot that was never committed](../img/missing-on-purpose.png)
