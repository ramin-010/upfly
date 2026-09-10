/**
 * The JSON adapter.
 *
 * This is the adapter the `speculative` flag exists for. A JSON file has no syntax
 * that says "this is an image" — `"icons/logo.png"` might be an asset path, a
 * translation key, a CSS class or an example in a schema, and telling those apart
 * would mean resolving the string, which an adapter may not do.
 *
 * So it is deliberately generous: every string *value* that carries a file
 * extension becomes a candidate, marked `asserted: false`. The resolver keeps the
 * ones that point at a real asset and discards the rest into a counted bucket. That
 * is why an unresolved candidate here is never a `broken` finding — otherwise every
 * `package.json`, lockfile and i18n bundle in the world would produce dozens.
 *
 * Being generous is the right bias: a discarded candidate costs a number in a
 * report, while a missed one costs a broken build after the image is rewritten.
 */

import { applyEdits } from '../edits.js';
import { extensionOf } from '../paths.js';
import type { Adapter, RawReference } from '../types.js';
import { isExternalUrl, splitPathSuffix } from './reference-path.js';

/** A JSON string literal, including its quotes. The `d` flag gives exact offsets. */
const STRING = /"(?:[^"\\]|\\.)*"/dg;

export const jsonAdapter: Adapter = {
  id: 'json',
  // `.webmanifest` is JSON, and a web app manifest is mostly icon paths — measured
  // on shadcn-ui, whose `site.webmanifest` lists three icons that were otherwise
  // swept as an *unread* file and hedged rather than linked.
  extensions: ['.json', '.webmanifest'],

  findReferences({ file, text }): RawReference[] {
    const references: RawReference[] = [];

    for (const match of text.matchAll(STRING)) {
      const quotedStart = match.index;
      const quoted = match[0];
      if (quotedStart === undefined) continue;

      // A string followed by a colon is a key. Keys are skipped: rewriting one
      // would change what a lookup finds, which is a different and riskier edit
      // than changing a path, and no format we support keys assets by name.
      if (isObjectKey(text, quotedStart + quoted.length)) continue;

      // The value between the quotes. Escapes are the one thing that breaks the
      // one-to-one mapping between source text and value, so those are skipped:
      // an escaped path cannot be located exactly, and a speculative candidate is
      // never a promise we made in the first place.
      const raw = quoted.slice(1, -1);
      if (raw.includes('\\')) continue;

      addCandidate(raw, quotedStart + 1, file, references);
    }

    return references.sort((a, b) => a.start - b.start);
  },

  rewrite({ text, edits }): string {
    return applyEdits(text, edits);
  },
};

function isObjectKey(text: string, afterString: number): boolean {
  for (let index = afterString; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (character === ':') return true;
    if (!/\s/.test(character)) return false;
  }
  return false;
}

function addCandidate(raw: string, start: number, file: string, references: RawReference[]): void {
  if (raw === '') return;
  if (isExternalUrl(raw, 'json')) return;

  const { path } = splitPathSuffix(raw);
  if (path === '') return;

  // Anything with a file extension is a candidate. This keeps the generosity
  // bounded without the adapter deciding what an *asset* extension is — that
  // policy lives in the resolver, in one place, for all five adapters.
  if (extensionOf(path) === '') return;

  references.push({
    file,
    start,
    // The range covers the path alone, so a rewrite preserves any `?v=2`.
    end: start + path.length,
    rawPath: path,
    kind: 'json',
    ceiling: 'high',
    // The whole point: the syntax does not assert this is an asset reference.
    asserted: false,
    note: 'a path-shaped string in JSON; kept only if it resolves to an asset',
  });
}
