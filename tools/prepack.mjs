#!/usr/bin/env node
// @ts-check
/**
 * Copies files from the repository's root into the package being packed, as its `prepack`
 * script: the licence into each package, and the README into the CLI's, so every tarball is
 * whole. Git ignores the copies; the files at the root are the ones to edit.
 *
 * A Markdown file's relative links and image paths are made absolute on the way, because
 * npm's page for a package has no repository to resolve them against.
 *
 * Usage: `node ../../tools/prepack.mjs <file>...`, run from the package's folder.
 */
import { copyFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The branch a published README's links point into: `v3`, which holds this code before
 * `main` does. A page published from here keeps its links for as long as the branch exists.
 */
const BRANCH = 'v3';
const PAGES = 'https://github.com/upflyjs/upfly';
const FILES = `https://raw.githubusercontent.com/upflyjs/upfly/${BRANCH}`;

/** A Markdown link or image, `[text](target)` or `![alt](target)`. */
const MARKDOWN_TARGET = /(!?)\[([^\]]*)\]\(([^)\s]+)\)/g;

/** An HTML attribute naming a file: `src`, `srcset` (one path here) or `href`. */
const HTML_TARGET = /\b(src|srcset|href)="([^"]+)"/g;

/**
 * Whether a link target is relative to the file it is in: not a URL with a scheme, not a
 * fragment on the same page, and not a path from the site's root.
 *
 * @param {string} target
 */
function isRelative(target) {
  return !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('#') && !target.startsWith('/');
}

/**
 * The absolute address of a path in the repository: its raw file for an image, which a page
 * shows, and its page on GitHub for a link, under `tree` for a folder and `blob` for a file.
 *
 * @param {string} target a path relative to the repository's root, perhaps with a `#fragment`
 * @param {boolean} shown whether the page shows the file, as an image, rather than links to it
 * @param {(relative: string) => boolean} isFolder whether a path names a folder
 */
function absolute(target, shown, isFolder) {
  const [file = '', fragment] = target.split('#', 2);
  const tail = fragment === undefined ? '' : `#${fragment}`;
  const bare = file.replace(/^\.\//, '').replace(/\/+$/, '');
  if (shown) return `${FILES}/${bare}${tail}`;
  return `${PAGES}/${isFolder(bare) ? 'tree' : 'blob'}/${BRANCH}/${bare}${tail}`;
}

/**
 * The Markdown with every relative link and image path made absolute, outside fenced code,
 * which a page shows as written.
 *
 * @param {string} markdown a file at the repository's root
 * @param {(relative: string) => boolean} isFolder whether a path names a folder
 * @returns {string}
 */
export function withAbsoluteLinks(markdown, isFolder) {
  let fenced = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) fenced = !fenced;
      if (fenced || /^\s*```/.test(line)) return line;
      return line
        .replace(MARKDOWN_TARGET, (whole, bang, text, target) =>
          isRelative(target)
            ? `${bang}[${text}](${absolute(target, bang === '!', isFolder)})`
            : whole,
        )
        .replace(HTML_TARGET, (whole, name, target) =>
          isRelative(target) ? `${name}="${absolute(target, name !== 'href', isFolder)}"` : whole,
        );
    })
    .join('\n');
}

/** @param {string} relative */
function isFolderInRepository(relative) {
  try {
    return statSync(path.join(ROOT, relative)).isDirectory();
  } catch {
    return false;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    process.stderr.write('prepack: name the files to copy from the repository root\n');
    process.exit(2);
  }
  for (const file of files) {
    const from = path.join(ROOT, file);
    const to = path.join(process.cwd(), file);
    if (file.endsWith('.md')) {
      writeFileSync(to, withAbsoluteLinks(readFileSync(from, 'utf8'), isFolderInRepository));
    } else {
      copyFileSync(from, to);
    }
  }
}
