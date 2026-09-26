/**
 * The JSON adapter.
 *
 * JSON has no syntax that says "this is an image": `"icons/logo.png"` might be an asset
 * path, a translation key or an example in a schema, and telling them apart would mean
 * resolving the string. So every string value that carries a file extension becomes a
 * speculative candidate (`asserted: false`). The resolver keeps the ones that name a real
 * asset and discards the rest into a counted bucket, never a `broken` finding. Erring wide
 * is the right bias: a discarded candidate costs a number in the report, a missed one a
 * broken build once the image is rewritten. See "Asserted versus speculative" in
 * ARCHITECTURE.md.
 */

import { extensionOf } from '../paths.js';
import type { ShapeId } from '../shapes.js';
import type { Adapter, RawReference } from '../types.js';
import { defineAdapter } from './define.js';
import { isExternalUrl, splitPathSuffix } from './reference-path.js';

/** A JSON string literal, including its quotes. */
const STRING = /"(?:[^"\\]|\\.)*"/dg;

export const jsonAdapter: Adapter = defineAdapter({
  id: 'json',
  // `.webmanifest` is JSON, and a web app manifest is mostly icon paths. Left unread,
  // its icons could only be reported as possibly dead rather than linked.
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
});

function isObjectKey(text: string, afterString: number): boolean {
  for (let index = afterString; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (character === ':') return true;
    if (!/\s/.test(character)) return false;
  }
  return false;
}

/**
 * Which shape a JSON candidate gets.
 *
 * Every path in a manifest gets `json.webmanifest.icon`, screenshots included: the scanner
 * walks string literals with a regex and does not know which array one sits in. Parsing
 * the structure would be a second JSON implementation for a distinction that only changes
 * the label, so `json.webmanifest.other` lists this shape in `adapterEmitsAs`.
 */
function shapeOf(path: string, file: string): ShapeId {
  // A glob names a set of files, not one file.
  if (path.includes('*')) return 'json.config.glob';

  const name = file.toLowerCase();
  if (name.endsWith('.webmanifest') || name.endsWith('manifest.json')) {
    return 'json.webmanifest.icon';
  }
  return 'json.config.value';
}

function addCandidate(raw: string, start: number, file: string, references: RawReference[]): void {
  if (raw === '') return;
  if (isExternalUrl(raw, 'json')) return;

  const { path } = splitPathSuffix(raw);
  if (path === '') return;

  // Anything with a file extension is a candidate. That bounds the guessing without the
  // adapter deciding which extensions are assets, which the resolver decides for every
  // adapter in one place.
  if (extensionOf(path) === '') return;

  references.push({
    file,
    start,
    // The range covers the path alone, so a rewrite preserves any `?v=2`.
    end: start + path.length,
    rawPath: path,
    kind: 'json',
    shape: shapeOf(path, file),
    ceiling: 'high',
    asserted: false,
    note: 'a path-shaped string in JSON; kept only if it resolves to an asset',
  });
}
