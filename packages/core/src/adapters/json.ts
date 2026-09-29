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

import { extensionOf, isImageExtension } from '../paths.js';
import type { Adapter, RawReference } from '../types.js';
import { defineAdapter } from './define.js';
import { isExternalUrl, plausiblePathShape, splitPathSuffix } from './reference-path.js';
import type { ShapeId } from './shapes.js';

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

      // A string followed by a colon is a key. A key is never read as a path: rewriting one
      // would change what a lookup finds, which is a different and riskier edit than
      // changing a path, and no format we support keys assets by name. One naming an image
      // is declined, so the report counts it.
      const raw = quoted.slice(1, -1);
      if (isObjectKey(text, quotedStart + quoted.length)) {
        declineCandidate(raw, quoted, quotedStart + 1, file, OBJECT_KEY, references);
        continue;
      }

      // Escapes are the one thing that breaks the one-to-one mapping between source text
      // and value: an escaped path cannot be located exactly, so it is never a candidate.
      // One naming an image is declined, its decoded path kept for the sweep.
      if (raw.includes('\\')) {
        declineCandidate(raw, quoted, quotedStart + 1, file, ESCAPED_STRING, references);
        continue;
      }

      addCandidate(raw, quotedStart + 1, file, references);
    }

    return references.sort((a, b) => a.start - b.start);
  },
});

const OBJECT_KEY = 'JSON object key, which Upfly does not read as a file path';

const ESCAPED_STRING =
  'JSON string written with escape sequences, whose text is not the path it spells';

/**
 * A key or an escaped string naming an image, returned declined under `reason` so the report
 * counts it, as the JavaScript reader counts its declines; anything else is left out. An
 * escaped one covers its whole text, and its decoded path travels as `assembledPath`, since no
 * range of the text spells it.
 */
function declineCandidate(
  raw: string,
  quoted: string,
  start: number,
  file: string,
  reason: string,
  references: RawReference[],
): void {
  const escaped = raw.includes('\\');
  const decoded = escaped ? jsonStringValue(quoted) : raw;
  if (decoded === null || isExternalUrl(decoded, 'json')) return;
  const { path } = splitPathSuffix(decoded);
  if (!isImageExtension(extensionOf(path)) || !plausiblePathShape(path)) return;
  const rawPath = escaped ? raw : path;
  references.push({
    file,
    start,
    end: start + rawPath.length,
    rawPath,
    kind: 'json',
    shape: shapeOf(path, file),
    ceiling: 'unsafe',
    asserted: false,
    declined: true,
    note: reason,
    ...(escaped ? { assembledPath: path } : {}),
  });
}

/** A JSON string's value, its escapes decoded, or `null` when an escape is malformed. */
function jsonStringValue(quoted: string): string | null {
  try {
    const value: unknown = JSON.parse(quoted);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

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
