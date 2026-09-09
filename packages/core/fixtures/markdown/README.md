# Example Project

![Build badge](./docs/badge.svg)

A realistic README. Everything commented out or fenced below is a trap for any
implementation that matches the whole file with a regular expression.

<p align="center">
  <img src="./docs/hero.png" alt="Hero" width="600">
</p>

## Screenshots

<picture>
  <source srcset="./docs/screen.avif 1x, ./docs/screen@2x.avif 2x" type="image/avif">
  <img src="./docs/screen.png" alt="Screenshot">
</picture>

See [the architecture diagram](./docs/architecture.png) for how it fits together.

## Usage

Embed an image with `![alt](./not-a-reference.png)` in your own docs.

```markdown
![This is documentation](./docs/example-only.png)
<img src="./docs/also-example-only.png">
```

```js
import logo from './docs/code-example.png';
```

<!--
Removed in v2:
![Old banner](./docs/old-banner.png)
<img src="./docs/old-inline.png">
-->

## Deployed docs

![Deployed logo]({{ site.baseurl }}/images/logo.png)

## Reference-style links

![Sponsor][sponsor]
![Remote][remote]

[sponsor]: ./docs/sponsor.png "Our sponsor"
[remote]: https://cdn.example.com/remote.png
