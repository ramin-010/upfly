#!/usr/bin/env node
// @ts-check
/**
 * Copies files from the repository's root into the package being packed, as its `prepack`
 * script: the licence into each package, and the README into the CLI's, so every tarball is
 * whole. Git ignores the copies; the files at the root are the ones to edit.
 *
 * Usage: `node ../../tools/prepack.mjs <file>...`, run from the package's folder.
 */
import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const files = process.argv.slice(2);
if (files.length === 0) {
  process.stderr.write('prepack: name the files to copy from the repository root\n');
  process.exit(2);
}
for (const file of files) copyFileSync(path.join(ROOT, file), path.join(process.cwd(), file));
