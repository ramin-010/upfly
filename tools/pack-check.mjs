#!/usr/bin/env node
// @ts-check
/**
 * Checks that a packed tarball holds everything its package's `files` list names, so a
 * package is never published without its README, its licence, its schemas or its build,
 * and that it holds no build cache and no source map, which point at a `src/` it does not
 * ship.
 *
 * Usage: `node tools/pack-check.mjs <package folder> <tarball>`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

/**
 * The paths of the files in a gzipped tar, as npm and pnpm write it: ustar headers, with a
 * pax record for a path too long for them.
 *
 * @param {Buffer} gzipped
 * @returns {string[]}
 */
export function tarPaths(gzipped) {
  const tar = gunzipSync(gzipped);
  /** @type {string[]} */
  const paths = [];
  /** @type {string | null} */
  let longPath = null;
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(field(header, 124, 12) || '0', 8);
    const type = String.fromCharCode(header[156] ?? 0);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    if (type === 'x') {
      longPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))?.[1] ?? null;
    } else {
      const prefix = field(header, 345, 155);
      const name = field(header, 0, 100);
      if (type === '0' || type === '\0') {
        paths.push(longPath ?? (prefix === '' ? name : `${prefix}/${name}`));
      }
      longPath = null;
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return paths;
}

/**
 * @param {Buffer} header
 * @param {number} start
 * @param {number} length
 */
function field(header, start, length) {
  const bytes = header.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? length : end).toString('utf8');
}

/**
 * The entries of a `files` list that a tarball does not hold. A folder counts as held when a
 * file inside it is, and an entry starting with `!` leaves files out rather than naming one.
 *
 * @param {readonly string[]} files the package's `files` list
 * @param {readonly string[]} paths the tarball's paths, each under `package/`
 * @returns {string[]}
 */
export function missingFromPack(files, paths) {
  const held = paths.map((file) => file.replace(/^package\//, ''));
  return files.filter((entry) => {
    if (entry.startsWith('!')) return false;
    const bare = entry.replace(/\/+$/, '');
    return !held.some((file) => file === bare || file.startsWith(`${bare}/`));
  });
}

/**
 * The files in a tarball that no user needs: the compiler's build cache (`.tsbuildinfo`) and
 * source maps (`.map`), which point at a `src/` the package does not ship.
 *
 * @param {readonly string[]} paths the tarball's paths, each under `package/`
 * @returns {string[]}
 */
export function unwantedInPack(paths) {
  return paths
    .map((file) => file.replace(/^package\//, ''))
    .filter((file) => file.endsWith('.tsbuildinfo') || file.endsWith('.map'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [folder, tarball] = process.argv.slice(2);
  if (folder === undefined || tarball === undefined) {
    process.stderr.write(
      'pack-check: usage: node tools/pack-check.mjs <package folder> <tarball>\n',
    );
    process.exit(2);
  }
  const manifest = JSON.parse(readFileSync(path.join(folder, 'package.json'), 'utf8'));
  const paths = tarPaths(readFileSync(tarball));
  const missing = missingFromPack(manifest.files ?? [], paths);
  if (missing.length > 0) {
    process.stderr.write(
      `pack-check: ${path.basename(tarball)} does not hold ${missing.join(', ')}, which the files list of ${manifest.name} names.\n`,
    );
    process.exit(1);
  }
  const unwanted = unwantedInPack(paths);
  if (unwanted.length > 0) {
    process.stderr.write(
      `pack-check: ${path.basename(tarball)} holds ${unwanted.join(', ')}, a build cache or source maps no user of ${manifest.name} needs.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `pack-check: ${path.basename(tarball)} holds everything the files list of ${manifest.name} names.\n`,
  );
}
