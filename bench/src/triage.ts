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

/** A grep hit the graph did not link, as the sweep produced it. */
export interface Hit {
  readonly asset: string;
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

export interface Triaged extends Hit {
  /** Why it cannot be a live reference, or `null` when a person must decide. */
  readonly explanation: string | null;
  /** A stable label for grouping the residue. `null` when explained. */
  readonly shape: string | null;
}

const MARKDOWN = new Set(['.md', '.mdx', '.markdown']);

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

  // A line the compiler never sees cannot break when the file is renamed.
  if (/^\s*(?:\/\/|\/\*|\*|#|<!--)/.test(hit.text)) {
    return 'commented out, so nothing resolves it';
  }

  // The line names a path, and that path is not this asset: `src/_data/mascots.js` writes
  // `/img/mascots/possum.jpg`, which matched `src/img/possum.jpg` by basename. Renaming
  // that asset would not touch the line.
  const named = pathEndingIn(hit.text, token);
  if (named?.includes('/') === true && !endsWithPath(hit.asset, named)) {
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

  // A documentation example being shown to a reader rather than run.
  if (MARKDOWN.has(extension) && /^\s*(?:import\b|<|\||\$|npm\b|npx\b|pnpm\b|#)/.test(hit.text)) {
    return 'inside a documentation example, not a live reference';
  }

  return null;
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

/** Could `asset` be what `named` refers to, ignoring any serving-root prefix? */
function endsWithPath(asset: string, named: string): boolean {
  const suffix = named.replace(/^\.?\/+/, '');
  return asset === suffix || asset.endsWith(`/${suffix}`);
}

function indexOfToken(text: string, token: string): number {
  return text.toLowerCase().indexOf(token.toLowerCase());
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
