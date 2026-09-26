/**
 * Whether anything the engine could not read as a reference mentions an asset by name.
 *
 * This separates a confident `dead` finding from a hedged `possibly-dead` one. The hedge
 * is per asset and needs evidence: a global one ("some extension went unread") fires on
 * every real repository and so says nothing. Candidate names go into one set and each
 * text is scanned once, not once per asset. Excluded directories are not swept: an
 * ignore rule is an instruction, and the report names them in one caveat line.
 * See "`possibly-dead`, and why "zero references" is usually a lie" in ARCHITECTURE.md.
 */

import { citeReferences, lineOf } from './citation.js';
import { formatBytes } from './format.js';
import type { Graph } from './graph.js';
import { unreferencedAssets } from './graph.js';
import { compareStrings, imageFilenameCandidates } from './paths.js';
import type { ReadFilePort, ScannedMention } from './scan.js';
import type { Reference } from './types.js';

/** Where an asset's name turned up. */
export type MentionSource =
  /** In a file no adapter could read: an unclaimed extension, or a parse failure. */
  | 'unscanned-file'
  /** In a path we read but could not resolve: `dynamic`, alias-shaped, or speculative. */
  | 'unresolved-reference'
  /**
   * In a file an adapter did read, in a form it did not understand: a template literal
   * in an object property parses fine and yields no reference. The last resort, used
   * only for an asset the other two sources did not explain.
   */
  | 'scanned-file';

/** Evidence that an asset with no references may nonetheless be in use. */
export interface Mention {
  /** POSIX-relative path of the asset that was named. */
  readonly asset: string;
  readonly source: MentionSource;
  /**
   * Where to look, as the report prints it: `src/posts/first.md:7`, or only the file
   * when it could not be re-read for the line. A line makes the mention an instruction
   * rather than a hint.
   */
  readonly where: string;
  /** The text that named it: the matched token, or the whole unresolved path. */
  readonly quote: string;
}

/** Text the sweep could not look at, and why. Each one is listed in the report. */
export interface SweepSkip {
  /** POSIX-relative path of the file. */
  readonly relative: string;
  readonly reason: string;
}

export interface SweepResult {
  /** Mentions per asset, keyed by POSIX-relative path. Only assets that were named. */
  readonly mentions: ReadonlyMap<string, readonly Mention[]>;
  /** Files the sweep could not read, sorted by `relative`. */
  readonly skipped: readonly SweepSkip[];
}

export interface SweepOptions {
  readonly graph: Graph;
  /** Same port `scan` takes. The sweep reads only what it must. */
  readonly readFile: ReadFilePort;
  /**
   * Asset filenames `scan` saw in files it did read, from `ScanResult.mentions`.
   *
   * A scanned file can hold a reference in a form no adapter understands (a template
   * literal in an object property parses fine and yields no reference), and neither other
   * source covers it. Collected during the scan, which already holds the text, so the
   * check is cheap enough to stay always on: `dead` means the filename appears nowhere in
   * the codebase, and a claim that holds only behind a flag is not that claim.
   */
  readonly scannedMentions?: readonly ScannedMention[];
  /**
   * Serving roots, as the resolver was given them.
   *
   * A filename inside an absolute URL is evidence only for an asset under a serving root:
   * `https://docs.astro.build/assets/arc.webp` may be `public/assets/arc.webp` being
   * served, but it cannot be an asset outside every serving root.
   */
  readonly publicDirs?: readonly string[];
  /**
   * Largest file the sweep will search, measured by the length of its text. Defaults to
   * 2 MiB.
   *
   * The unread set is mostly templates and config, but it can also hold fonts, video and
   * archives. A larger file is skipped with a reason, because a silent skip would turn a
   * hedge back into a confident `dead`.
   */
  readonly maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Looks for the names of assets nothing references in the files no adapter could read,
 * the paths that did not resolve, and the filenames `scan` saw in the files it read.
 *
 * Does no IO when every asset is referenced, the common case on a healthy repository.
 */
export async function sweepForMentions(options: SweepOptions): Promise<SweepResult> {
  const { graph } = options;
  const candidates = candidateBasenames(graph);
  const mentions = new Map<string, Mention[]>();
  const skipped: SweepSkip[] = [];

  if (candidates.size === 0) return { mentions, skipped };

  await sweepFiles(
    options.graph.unscannedFiles,
    'unscanned-file',
    options,
    candidates,
    mentions,
    skipped,
  );
  await sweepUnresolvedReferences(options, candidates, mentions, skipped);

  // Only assets the other sources left unexplained. No IO: `scan` gathered these while
  // it had the text open.
  for (const mention of options.scannedMentions ?? []) {
    for (const asset of candidates.get(mention.basename) ?? []) {
      if (mentions.has(asset)) continue;
      record(mentions, {
        asset,
        source: 'scanned-file',
        where: `${mention.relative}:${mention.line}`,
        quote: mention.quote,
      });
    }
  }

  for (const list of mentions.values()) list.sort(byWhereThenQuote);
  return { mentions, skipped };
}

/**
 * Assets with zero references, indexed by lowercased basename.
 *
 * A basename rather than a path, because that is all an unread file gives: a `.vue`
 * template says `hero.png`, not where it lives. Two assets sharing a basename are both
 * hedged, since the evidence cannot tell them apart and hedging is the safe error.
 * Lowercased because Windows filesystems are case-insensitive, so `Hero.PNG` in a
 * template can name `hero.png`.
 */
function candidateBasenames(graph: Graph): ReadonlyMap<string, readonly string[]> {
  const byBasename = new Map<string, string[]>();

  for (const node of unreferencedAssets(graph)) {
    const relative = node.asset.relative;
    const basename = relative.slice(relative.lastIndexOf('/') + 1).toLowerCase();
    const existing = byBasename.get(basename);
    if (existing === undefined) byBasename.set(basename, [relative]);
    else existing.push(relative);
  }

  return byBasename;
}

/** Read a set of files and record every candidate basename they name. */
async function sweepFiles(
  files: readonly { readonly path: string; readonly relative: string }[],
  source: MentionSource,
  options: SweepOptions,
  candidates: ReadonlyMap<string, readonly string[]>,
  mentions: Map<string, Mention[]>,
  skipped: SweepSkip[],
): Promise<void> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  for (const file of files) {
    let text: string;
    try {
      text = await options.readFile(file.path);
    } catch (error) {
      skipped.push({ relative: file.relative, reason: describe(error) });
      continue;
    }

    if (text.length > maxBytes) {
      skipped.push({
        relative: file.relative,
        // Human scale, since the report prints this verbatim. `formatBytes` rather than
        // fixed megabytes, which would print a small limit as `0 MB`.
        reason: `larger than the ${formatBytes(maxBytes)} limit for searching a file's text`,
      });
      continue;
    }

    for (const [token, index] of tokens(text)) {
      const inUrl = isInsideAbsoluteUrl(text, index);
      for (const asset of candidates.get(token.toLowerCase()) ?? []) {
        if (inUrl && !isServed(asset, options.publicDirs)) continue;
        record(mentions, {
          asset,
          source,
          where: `${file.relative}:${lineOf(text, index)}`,
          quote: token,
        });
      }
    }
  }
}

/**
 * Paths the engine read but could not resolve.
 *
 * Searching them costs no IO, since the strings are in the graph, but each mention cites
 * its line and a line costs a re-read. `citeReferences` re-reads once per file, and only
 * for references that named a candidate.
 */
async function sweepUnresolvedReferences(
  options: SweepOptions,
  candidates: ReadonlyMap<string, readonly string[]>,
  mentions: Map<string, Mention[]>,
  skipped: SweepSkip[],
): Promise<void> {
  const hits: { reference: Reference; asset: string }[] = [];

  for (const reference of unknownTargetReferences(options.graph)) {
    for (const [token] of tokens(reference.rawPath)) {
      for (const asset of candidates.get(token.toLowerCase()) ?? []) {
        hits.push({ reference, asset });
      }
    }
  }
  if (hits.length === 0) return;

  const { citations, unreadable } = await citeReferences({
    references: hits.map((hit) => hit.reference),
    root: options.graph.root,
    readFile: options.readFile,
  });
  // A file that cannot be re-read loses the line, not the mention, and is listed as skipped.
  skipped.push(...unreadable);

  for (const hit of hits) {
    record(mentions, {
      asset: hit.asset,
      source: 'unresolved-reference',
      where: citations.get(hit.reference)?.where ?? '',
      quote: hit.reference.rawPath,
    });
  }
}

/**
 * The references whose target is unknown, the only ones that can hint at a use.
 *
 * A known target is no such evidence. `broken` points at nothing and is its own finding:
 * `./wrong-dir/hero.png: broken` beside `hero.png: dead` tells a reader more than a hedge
 * would. `out-of-scope` is known not to be an indexed asset. A new resolution outcome
 * belongs here only if its target is unknown.
 */
function unknownTargetReferences(graph: Graph): readonly Reference[] {
  return [
    ...graph.byResolution.dynamic,
    ...graph.byResolution['unresolved-alias'],
    ...graph.byResolution.discarded,
  ];
}

/** Whether this token sits inside an `http://` or `https://` URL. */
function isInsideAbsoluteUrl(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf('\n', index) + 1;
  return /https?:\/\/\S*$/.test(text.slice(lineStart, index));
}

/** Whether an asset lives under a serving root, so a URL could genuinely serve it. */
function isServed(asset: string, publicDirs: readonly string[] | undefined): boolean {
  return (publicDirs ?? []).some(
    (publicDir) => publicDir === '' || asset === publicDir || asset.startsWith(`${publicDir}/`),
  );
}

/**
 * Every filename-shaped token in a string, with the offset it started at.
 *
 * Delegates to `imageFilenameCandidates`, which also yields names containing spaces
 * (`Firing Practice.webp`, not only `Practice.webp`). `scan.ts` uses the same generator,
 * so the two lookups cannot disagree.
 */
function* tokens(text: string): Generator<[string, number]> {
  yield* imageFilenameCandidates(text);
}

function record(mentions: Map<string, Mention[]>, mention: Mention): void {
  const list = mentions.get(mention.asset);
  if (list === undefined) mentions.set(mention.asset, [mention]);
  else if (!list.some((entry) => entry.where === mention.where && entry.quote === mention.quote)) {
    list.push(mention);
  }
}

function byWhereThenQuote(a: Mention, b: Mention): number {
  return compareStrings(a.where, b.where) || compareStrings(a.quote, b.quote);
}

function describe(error: unknown): string {
  if (error instanceof Error && 'code' in error) {
    const { code } = error as Error & { code?: unknown };
    if (typeof code === 'string') return code;
  }
  return error instanceof Error ? error.message : String(error);
}
