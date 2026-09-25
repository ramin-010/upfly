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
unresolvable is *never rewritten* and *always reported*. From a real run on a copy of
[11ty/docs](https://github.com/11ty/docs) at `028e255`, lines left out marked `[...]`:

```
$ upfly optimize --apply --commit
Upfly audit
[...]
  25 of 86 references resolved, pointing at 24 of those images
[...]
56 references had no answer to find
[...]
  plus 52 with no filename to check — each builds its path at runtime
[...]
Examined and not converted

  4 images, 93.4 KB, with no conversion to offer (use --include-declined to list them)
[...]
Plan

  Convert to WebP: 25 images, 5.7 MB now and 1.4 MB after
[...]
    src/blog/six-million.jpg → src/blog/six-million.webp  2.2 MB → 489.8 KB
[...]
  Update references: 18 references in 13 files
[...]
Written as run 20260925T204012-4af6: 25 files created, 13 changed, 0 removed. `upfly undo` puts them all back.
Committed as 609a4057f0a6, one commit holding exactly those files. `git revert 609a4057f0a6` undoes it.
```

Saying what it could not follow is what makes the 18 references it did rewrite trustworthy.

**Undo is real.** Dry-run is the default. `--apply` refuses to run on a dirty git tree.
`--commit` writes exactly one commit, so `git revert` undoes everything and your normal code
review catches anything odd.

**No network. No telemetry.** Ever. Everything runs locally.

## Development

Requires Node ≥ 20 and pnpm.

```bash
pnpm install
pnpm check     # lint + comment check + typecheck + test — the same gate CI runs
pnpm coverage  # core must stay above 90%
```

## License

MIT © [Rinkal Kumar](https://github.com/ramin-010)
