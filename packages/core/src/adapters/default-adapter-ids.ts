/**
 * The ids of the adapters a parse pool worker can import, and nothing else.
 *
 * 🔴 **A separate module because `scan.ts` is deliberately adapter-free** — it owns error
 * handling across every adapter and is tested against an in-memory file map rather than a
 * tree of deliberately broken files. Importing `default-adapters.js` to read a list of
 * strings would drag parse5, Babel and PostCSS into that module and cost the property the
 * file comment opens by claiming.
 *
 * ⚠️ **A hand-kept copy of a list is exactly the kind of thing that drifts**, so it is not
 * kept by hand: `default-adapters.test.ts` asserts this list and `defaultAdapters` agree,
 * both ways. An adapter added to one and not the other fails the gate rather than quietly
 * putting every scan back on the main thread with `reason: 'custom-adapter'` — which would
 * look like a slow day rather than like a bug.
 */
export const DEFAULT_ADAPTER_IDS: readonly string[] = Object.freeze([
  'astro',
  'css',
  'html',
  'javascript',
  'json',
  'markdown',
]);
