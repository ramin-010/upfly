/**
 * §5.1(b): sorting grep hits into the ones a person has to rule on.
 *
 * The sweep greps every discovered asset's filename across the repository and hands
 * back every hit the graph did not link. Most are not references at all — a filename
 * in a sentence, a commented-out line, a different file that happens to share a
 * basename — and burying the real misses among them is how 253 hits become nobody's
 * problem.
 *
 * ⚠️ **Every rule here is conservative on purpose, and the asymmetry is the whole
 * design.** A hit wrongly marked *explained* is a false negative hidden by the very
 * pass built to find false negatives — the worst outcome available, because nothing
 * downstream looks again. A hit wrongly left for a person costs a few seconds. So
 * each rule below fires only on evidence that the line **cannot** be a live
 * reference to **this** asset, and anything short of that is left alone.
 *
 * The useful question behind all of it, and the one to keep in mind when reading a
 * residue item: *if this image were renamed, would this line break?*
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

  // An absolute URL to somewhere else is not a reference to a file here. It is not
  // enough that the line contains a URL — the token has to be *inside* it.
  if (/https?:\/\/\S*$/.test(before)) {
    return 'part of an absolute URL, which was never a candidate reference';
  }

  // A line the compiler never sees cannot break when the file is renamed.
  if (/^\s*(?:\/\/|\/\*|\*|#|<!--)/.test(hit.text)) {
    return 'commented out, so nothing resolves it';
  }

  // The strongest rule, and the only mechanical one: the line names a path, and that
  // path is not this asset. `src/_data/mascots.js` writes `/img/mascots/possum.jpg`
  // and the sweep matched it to `src/img/possum.jpg` — same basename, different
  // file. Renaming *this* asset would not touch that line.
  const named = pathEndingIn(hit.text, token);
  if (named?.includes('/') === true && !endsWithPath(hit.asset, named)) {
    return `the line names ${named}, which is a different file that shares a basename`;
  }

  // Prose. Narrow deliberately: Markdown only, the bare filename with no path and no
  // quotes or brackets around it, in something long enough to be a sentence. A
  // filename inside `src="…"` or a link target is excluded by that first condition.
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
 * A label for the residue, so identical decisions are made once.
 *
 * Grouping is what stops the leftovers being a list of 89 near-identical lines; the
 * §5.1(d) worksheet learned the same lesson from twenty scaffolding fixtures that
 * were one judgement call.
 */
function shapeOf(hit: Hit, extension: string, token: string): string {
  const before = hit.text.slice(0, Math.max(0, indexOfToken(hit.text, token)));

  // The directory part sits between the quote and the filename, so both of these
  // have to allow it. Keying on "quote immediately followed by the token" labelled
  // every reference that names a directory as prose instead.
  //
  // Regex literals rather than `new RegExp` with an interpolated fragment: this
  // harness eats backslashes in a string, and `'[\w…]'` silently becomes `[w…]` —
  // a character class that still compiles and quietly matches the wrong thing.
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
