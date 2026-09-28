/**
 * Sorts the false-negative sweep's hits into those a person has to rule on.
 *
 * `validate.ts` searches the repository for every asset's filename and passes on each hit
 * the graph did not link. Most are not references: a filename in a sentence, a
 * commented-out line, a different file that shares a basename. A rule here explains a hit
 * only on evidence that the line cannot be a live reference to this asset, because the
 * costs are unequal: a hit wrongly explained is a missed reference that nothing looks at
 * again, and a hit wrongly left for a person costs a few seconds. The question behind
 * every rule: if this image were renamed, would this line break?
 */

import { posix } from 'node:path';
import { imageFilenameCandidates } from 'upfly-core';

/** A grep hit the graph did not link, as the sweep produced it. */
export interface Hit {
  readonly asset: string;
  readonly file: string;
  readonly line: number;
  readonly text: string;
  /**
   * Whether a fenced code block holds the line (`fencedLines`). In Markdown that makes it an
   * example shown to a reader; outside a fence the same line is live.
   */
  readonly fenced: boolean;
}

export interface Triaged extends Hit {
  /** Why it cannot be a live reference, or `null` when a person must decide. */
  readonly explanation: string | null;
  /** A stable label for grouping the residue. `null` when explained. */
  readonly shape: string | null;
}

const MARKDOWN = new Set(['.md', '.mdx', '.markdown']);

/**
 * The hits in one file: every place its text names an asset by filename, matched on the
 * basename and ignoring case, each with its line and whether a fenced code block holds it.
 *
 * The names are the engine's own candidates (`imageFilenameCandidates`), so every name the
 * scan and the mention sweep can spell, one holding spaces or parentheses included, is
 * searched for here too. A pattern of its own would make this pass blind to exactly the
 * names those passes were fixed to read.
 *
 * @param file POSIX-relative, as a hit reports it.
 * @param assetsNamed The assets a lowercased filename could be. The sweep leaves out those
 *   the graph already links from this file.
 */
export function hitsIn(
  file: string,
  text: string,
  assetsNamed: (name: string) => readonly string[],
): Hit[] {
  const hits: Hit[] = [];
  // Read once a file has a hit, since most have none.
  let fenced: ReadonlySet<number> | undefined;
  for (const [name, offset] of imageFilenameCandidates(text)) {
    for (const asset of assetsNamed(name.toLowerCase())) {
      const line = lineOf(text, offset);
      fenced ??= fencedLines(text);
      hits.push({ asset, file, line, text: lineText(text, offset), fenced: fenced.has(line) });
    }
  }
  return hits;
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index++) {
    if (text[index] === '\n') line += 1;
  }
  return line;
}

function lineText(text: string, offset: number): string {
  const start = text.lastIndexOf('\n', offset) + 1;
  const end = text.indexOf('\n', offset);
  return text
    .slice(start, end === -1 ? undefined : end)
    .trim()
    .slice(0, 160);
}

export function triage(hit: Hit, claimed: ReadonlySet<string>): Triaged {
  const extension = hit.file.slice(hit.file.lastIndexOf('.')).toLowerCase();
  const token = basename(hit.asset);
  const explanation = explain(hit, extension, token, claimed);

  return {
    ...hit,
    explanation,
    shape: explanation === null ? shapeOf(hit, extension, token) : null,
  };
}

function explain(
  hit: Hit,
  extension: string,
  token: string,
  claimed: ReadonlySet<string>,
): string | null {
  if (!claimed.has(extension)) {
    return `no adapter reads ${extension} — covered by unscannedExtensions and possibly-dead`;
  }

  const before = hit.text.slice(0, Math.max(0, indexOfToken(hit.text, token)));

  // An absolute URL to somewhere else is not a reference to a file here. The token has to
  // be inside the URL, not merely on the same line.
  if (/https?:\/\/\S*$/.test(before)) {
    return 'part of an absolute URL, which was never a candidate reference';
  }

  // A line the compiler never sees cannot break when the file is renamed. The comment is
  // read by the file type's own syntax: no type an adapter reads comments with `#`, and in
  // Markdown `*` starts a list item and only `<!--` opens a comment.
  const comment = MARKDOWN.has(extension) ? /^\s*<!--/ : /^\s*(?:\/\/|\/\*|\*|<!--)/;
  if (comment.test(hit.text)) {
    return 'commented out, so nothing resolves it';
  }

  // The line names a path, and that path is not this asset: `src/_data/mascots.js` writes
  // `/img/mascots/possum.jpg`, which matched `src/img/possum.jpg` by basename. Renaming
  // that asset would not touch the line.
  const named = pathEndingIn(hit.text, token);
  if (named?.includes('/') === true && !couldNameAsset(hit.asset, named, hit.file)) {
    return `the line names ${named}, which is a different file that shares a basename`;
  }

  // Prose, narrowly: in Markdown, a bare filename with no path and no quote, bracket or `=`
  // before it, on a line long enough to be a sentence. That excludes a filename inside
  // `src="…"` or a link target.
  if (
    MARKDOWN.has(extension) &&
    named === token &&
    !/["'`(\[=]\s*$/.test(before) &&
    hit.text.split(/\s+/).length >= 8
  ) {
    return 'a filename inside a sentence, not a reference';
  }

  // A documentation example being shown to a reader rather than run, which only a fence
  // makes it: outside one, raw HTML, a table row and an MDX import are all live. A heading
  // is not one.
  if (
    MARKDOWN.has(extension) &&
    hit.fenced &&
    /^\s*(?:import\b|<|\||\$|npm\b|npx\b|pnpm\b)/.test(hit.text)
  ) {
    return 'inside a documentation example, not a live reference';
  }

  return null;
}

/**
 * The 1-based numbers of the lines that a Markdown file's fenced code blocks hold, their
 * fence lines included.
 *
 * Read here rather than taken from the engine, so a masking mistake there cannot hide the
 * reference it misses. A line counts only when a fence certainly holds it, so a fence that
 * never closes holds nothing and its lines go to a person. A fence indented four spaces or
 * more, as one under a list item is, counts only when a closing line follows beside its
 * indent and every line between is blank or indented as far: read as indented code
 * instead, those lines are code as well.
 * https://spec.commonmark.org/0.31.2/#fenced-code-blocks
 */
export function fencedLines(text: string): ReadonlySet<number> {
  const lines = text
    .split('\n')
    .map((written) => (written.endsWith('\r') ? written.slice(0, -1) : written));
  const fenced = new Set<number>();
  let index = 0;
  while (index < lines.length) {
    const opener = fenceLine(lines[index] ?? '');
    const last = opener === null ? -1 : closingIndex(lines, index, opener);
    if (last === -1) {
      index += 1;
      continue;
    }
    for (let number = index + 1; number <= last + 1; number += 1) fenced.add(number);
    index = last + 1;
  }
  return fenced;
}

/** A line of three or more backticks or tildes: its indent, the run, and what follows it. */
interface FenceLine {
  readonly indent: number;
  readonly run: string;
  readonly info: string;
}

function fenceLine(line: string): FenceLine | null {
  const match = /^( *)(`{3,}|~{3,})(.*)$/.exec(line);
  if (match === null) return null;
  const [, spaces = '', run = '', info = ''] = match;
  // A backtick fence's info string may not hold a backtick: such a line is inline code.
  if (run.startsWith('`') && info.includes('`')) return null;
  return { indent: spaces.length, run, info };
}

/**
 * The index of the line that closes the fence opened at `start`: the same character, a run
 * at least as long and nothing after it. -1 when no line certainly does.
 */
function closingIndex(lines: readonly string[], start: number, opener: FenceLine): number {
  const nested = opener.indent > 3;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const fence = fenceLine(line);
    const closes =
      fence !== null &&
      fence.run[0] === opener.run[0] &&
      fence.run.length >= opener.run.length &&
      fence.info.trim() === '' &&
      (nested ? Math.abs(fence.indent - opener.indent) <= 3 : fence.indent <= 3);
    if (closes) return index;
    if (nested && line.trim() !== '' && line.length - line.trimStart().length < opener.indent) {
      return -1;
    }
  }
  return -1;
}

/**
 * A label for the residue, so hits that need the same decision are grouped and decided
 * once.
 */
function shapeOf(hit: Hit, extension: string, token: string): string {
  const before = hit.text.slice(0, Math.max(0, indexOfToken(hit.text, token)));

  // The directory part sits between the quote and the filename, so both patterns allow it.
  // Without that, a reference that names a directory misses both and gets a generic label.
  //
  // Regex literals rather than `new RegExp` over a string: in a string, `'[\w…]'` is
  // `'[w…]'`, which still compiles and matches the wrong thing.
  if (/^\s*[\w-]+:\s*["']?[\w@.\-/]*$/.test(before)) {
    return 'a key/value pair in data or frontmatter';
  }
  if (/(?:src|href|poster|content|url)\s*=\s*["'`]?[\w@.\-/]*$/i.test(before)) {
    return 'an attribute';
  }
  if (MARKDOWN.has(extension)) return 'markdown prose or an example';
  if (extension === '.json') return 'a string inside JSON';
  return `a string in ${extension}`;
}

/** The longest path-looking run of text ending at this filename. */
function pathEndingIn(text: string, token: string): string | null {
  const index = indexOfToken(text, token);
  if (index === -1) return null;

  let start = index;
  while (start > 0 && /[\w@.\-/]/.test(text[start - 1] ?? '')) start -= 1;

  return text.slice(start, index + token.length).replace(/^\/+/, '');
}

/**
 * Could `named`, written in `file`, be `asset`? A path that starts `./` or `../` has one
 * reading, from the directory of the file that holds it. Any other is compared as a suffix,
 * which allows for a serving-root prefix.
 */
function couldNameAsset(asset: string, named: string, file: string): boolean {
  if (/^\.\.?\//.test(named)) {
    return posix.normalize(posix.join(posix.dirname(file), named)) === asset;
  }
  const suffix = named.replace(/^\/+/, '');
  return asset === suffix || asset.endsWith(`/${suffix}`);
}

function indexOfToken(text: string, token: string): number {
  return text.toLowerCase().indexOf(token.toLowerCase());
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
