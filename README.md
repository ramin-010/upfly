# upfly

**Optimize your repo's images without breaking a reference.**

Lighthouse tells you to serve images in next-gen formats. Every tool that does it either
leaves your source alone (build-time plugins) or converts the file and breaks every
`import`, `src`, `url()` and `srcset` that pointed at it.

Upfly builds a graph of every image in your repository and every place it is referenced,
converts the images, and rewrites the references — transactionally, and never silently.

```bash
npx upfly audit      # what's wrong: dead assets, broken paths, oversized images
npx upfly optimize   # dry run: exactly what would change
npx upfly optimize --apply --commit
```

> **Status: in development.** The engine is being built in the open; nothing is published
> yet. See [ARCHITECTURE.md](ARCHITECTURE.md) for the design and
> [CONTRIBUTING.md](CONTRIBUTING.md) if you want to help.
>
> Looking for the Express upload middleware? That is the v2 line: `npm install upfly@2`.

## What makes it different

**It knows where your images are used.** Not just `public/` — imports in components, `url()`
in stylesheets, `srcset` on `<picture>`, paths in manifests and Markdown.

**It never fails silently.** Every reference gets a confidence tier, and anything dynamic or
unresolvable is *never rewritten* and *always reported*:

```
47 images optimized · 122 references updated · 14.2 MB saved

2 references could not be safely rewritten:
  src/gallery.tsx:88   `/img/${slug}.png`   dynamic path, no single target
  src/legacy.js:14     require(imgPath)     variable path
```

Admitting those two is what makes the other 122 trustworthy.

**Undo is real.** Dry-run is the default. `--apply` refuses to run on a dirty git tree.
`--commit` writes exactly one commit, so `git revert` undoes everything and your normal code
review catches anything odd.

**No network. No telemetry.** Ever. Everything runs locally.

## Development

Requires Node ≥ 20 and pnpm.

```bash
pnpm install
pnpm check     # lint + typecheck + test — the same gate CI runs
pnpm coverage  # core must stay above 90%
```

## License

MIT © [Rinkal Kumar](https://github.com/ramin-010)
