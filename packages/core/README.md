# upfly-core

The engine behind [`upfly`](https://www.npmjs.com/package/upfly): it finds every image in a
project and every reference to one, plans conversions to WebP or AVIF, and rewrites the
references in one transaction that can be undone. It makes no network calls.

Most people want the command-line tool rather than this package:

```bash
npm install --save-dev upfly
npx upfly audit
```

This package is for building on the engine: `runPipeline` and `buildReport` run the audit
and give its report, `optimizeProject` converts images and rewrites their references,
`dedupeProject` points references to identical copies at one copy, and `readManifest`,
`inspect` and `revert` undo the last run. Every export is documented in its TypeScript
declarations, which an editor shows on hover, and the design is described in
`ARCHITECTURE.md` in the [repository](https://github.com/ramin-010/upfly).

`upfly-core/internal` holds the rest of the engine for the `upfly` CLI and the repository's
own tools. It is not part of the public API: any name in it can change in any release.

## License

MIT
