/**
 * Lists every asset-shaped token in the tree with its position, so a person can decide what
 * each one means. It finds where; the key's `expect` values come from a person, since a
 * scanner cannot know whether a path in a log message is a reference. `check-key.mjs` runs
 * the same scan to prove the key lists every occurrence.
 *
 * It imports only `node:` modules, because the self-check imports it and must not be able
 * to reach the engine.
 *
 * Usage: node tools/scan-occurrences.mjs [--root DIR] [--file SUBSTRING] [--json]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ASSET_EXTENSIONS = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'avif',
  'ico',
  'bmp',
  'tif',
  'tiff',
  'mp4',
  'webm',
  'mp3',
  'ogg',
  'vtt',
  'pdf',
  'woff',
  'woff2',
  'webmanifest',
];

/**
 * A path-shaped token ending in an asset extension. It is not anchored to quotes or
 * attributes, so it also finds text that only looks like an asset, in prose and comments:
 * the occurrences a key is most likely to forget. Its limits:
 *   - a space or a parenthesis in a filename stops the match early (`/gallery/hero image.png`
 *     is found as `image.png`); the checker accepts a hit inside a listed reference's span.
 *   - parentheses are kept out of the character class, or `](/img/hero.jpg)` and
 *     `url(/img/hero.jpg)` would match from before the path and fall outside that span.
 *   - source extensions (.css, .ts, .json) are not scanned, so an unlisted reference to a
 *     stylesheet is not caught.
 */
export const TOKEN_RE = new RegExp(
  String.raw`[A-Za-z0-9_@%&.~+\-/]*\.(?:${ASSET_EXTENSIONS.join('|')})(?![A-Za-z0-9])`,
  'gi',
);

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next']);

/** Files whose bytes are the asset itself rather than text about assets. */
const BINARY_RE = /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|mp4|webm|mp3|ogg|pdf|woff2?)$/i;

export function listTextFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile() && !BINARY_RE.test(entry.name)) {
        out.push(relative(root, full).split(sep).join('/'));
      }
    }
  };
  walk(root);
  return out;
}

export function listAssetFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile() && BINARY_RE.test(entry.name)) {
        const rel = relative(root, full).split(sep).join('/');
        out.push({ path: rel, bytes: statSync(full).size });
      }
    }
  };
  walk(root);
  return out;
}

/** Byte offset -> 1-based line and column, counting UTF-8 bytes. */
export function positionOf(buf, offset) {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i += 1) {
    if (buf[i] === 0x0a) {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

export function scanFile(root, rel) {
  const buf = readFileSync(join(root, rel));
  const text = buf.toString('utf8');
  const hits = [];
  TOKEN_RE.lastIndex = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const charIndex = m.index ?? 0;
    const offset = Buffer.byteLength(text.slice(0, charIndex), 'utf8');
    hits.push({ token: m[0], offset, ...positionOf(buf, offset) });
  }
  return hits;
}

function main() {
  const args = process.argv.slice(2);
  const rootArg = args.indexOf('--root');
  const root = rootArg === -1 ? join(process.cwd(), 'tree') : args[rootArg + 1];
  const fileArg = args.indexOf('--file');
  const filter = fileArg === -1 ? null : args[fileArg + 1];
  const asJson = args.includes('--json');

  const report = [];
  for (const rel of listTextFiles(root)) {
    if (filter && !rel.includes(filter)) continue;
    const hits = scanFile(root, rel);
    if (hits.length > 0) report.push({ file: rel, hits });
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  let total = 0;
  for (const { file, hits } of report) {
    process.stdout.write(`\n=== ${file}  (${hits.length})\n`);
    for (const h of hits) {
      total += 1;
      process.stdout.write(
        `  ${String(h.line).padStart(4)}:${String(h.column).padEnd(4)} @${String(h.offset).padStart(6)}  ${h.token}\n`,
      );
    }
  }
  process.stdout.write(`\n${total} occurrences in ${report.length} files\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
