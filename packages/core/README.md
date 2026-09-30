# upfly-core

The engine behind [`upfly`](https://www.npmjs.com/package/upfly): it finds every image in a
project and every reference to one, plans conversions to WebP or AVIF, and rewrites the
references in one transaction that can be undone. It makes no network calls.

Most people want the command-line tool rather than this package:

```bash
npm install --save-dev upfly
npx upfly audit
```

This package is for building on the engine. Every export is documented in its TypeScript
declarations, which an editor shows on hover, and the design is described in
`ARCHITECTURE.md` in the [repository](https://github.com/ramin-010/upfly).

## License

MIT
