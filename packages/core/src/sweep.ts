/**
 * Find out whether anything we could not read mentions an asset by name.
 *
 * This is what separates a confident `dead` finding from a hedged `possibly-dead`
 * one, and it exists because the obvious rule degenerates. Hedging globally —
 * "some extension went unread, so every dead asset might be alive" — fires on every
 * real repository (this one's unread list is `.astro`, `.njk`, `.yaml`, `.yml`,
 * three dotfiles and `LICENSE`), so `dead` never appears and a label that always
 * appears carries no information.
 *
 * So the hedge is per asset, and it needs evidence. **The principle: hedge on
 * references whose target is UNKNOWN, never on references whose target is KNOWN.**
 * That generates both haystacks and both exclusions:
 *
 * | outcome | target | swept? |
 * |---|---|---|
 * | `dynamic` | unknown — there was never a static path | yes |
 * | `unresolved-alias` | unknown — Phase 2 resolves these | yes |
 * | `discarded` | unknown — speculative, did not resolve | yes |
 * | `broken` | known: nothing | no — and it is already its own finding |
 * | `out-of-scope` | known, and known not to be an indexed asset | no |
 *
 * `broken` staying out is worth the second reason: `hero.png: dead` sitting beside
 * `./wrong-dir/hero.png: broken` tells a reader more than hedging `hero.png` would.
 * The two findings pair diagnostically, and hedging would hide the signal.
 *
 * Directories the user excluded are not swept at all. An ignore rule is an
 * instruction, not a gap in our coverage, and walking a pruned `node_modules` to
 * hedge a report would be absurd — the report names them in one caveat line instead.
 *
 * **One pass over the text, not one pass per asset.** The candidate basenames go
 * into a set, and each haystack is scanned once for filename-shaped tokens which are
 * then looked up. A thousand dead assets against five hundred unread files would
 * otherwise be half a million substring searches.
 */

import { citeReferences, lineOf } from './citation.js';
import type { Graph } from './graph.js';
import { unreferencedAssets } from './graph.js';
import { IMAGE_EXTENSIONS, compareStrings } from './paths.js';
import type { ReadFilePort } from './scan.js';
import type { Reference } from './types.js';

/** Where an asset's name turned up. */
export type MentionSource =
  /** In a file no adapter could read — an unclaimed extension, or a parse failure. */
  | 'unscanned-file'
  /** In a path we read but could not resolve: `dynamic`, alias-shaped, or speculative. */
  | 'unresolved-reference';

/** Evidence that an asset with no references may nonetheless be in use. */
export interface Mention {
  /** POSIX-relative path of the asset that was named. */
  readonly asset: string;
  readonly source: MentionSource;
  /**
   * Where to look, as the report prints it: `config.yaml`, or
   * `src/posts/first.md:7`.
   *
   * R10 makes the line mandatory for an unresolved reference. "Named by a path
   * Upfly could not resolve, somewhere" is a hint; naming the line is an
   * instruction, and it is the thing this source can do that the other cannot.
   */
  readonly where: string;
  /** The text that named it — the matched token, or the whole unresolved path. */
  readonly quote: string;
}

/** Text the sweep could not look at, and why. Rule 9 reaches here too. */
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
   * Largest file the sweep will read, in bytes. Defaults to 2 MiB.
   *
   * The unread set is mostly templates and config, but it also holds fonts, video
   * and archives — §5.1(e) has a 200 MB file in it. Anything larger is skipped
   * *with a reason*, because a silent skip here would quietly turn a hedge back
   * into a confident `dead`.
   */
  readonly maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Matches a filename-shaped token ending in a tracked image extension.
 *
 * Built from `IMAGE_EXTENSIONS` so the tracked-format policy stays in one place —
 * adding AVIF or SVG support later must not require remembering this file. The
 * character class deliberately excludes `/`, so `{{ site.url }}/img/hero.png`
 * yields `hero.png` and nothing longer.
 */
function filenamePattern(): RegExp {
  const extensions = IMAGE_EXTENSIONS.map((extension) => extension.slice(1).replace(/\W/g, '\\$&'));
  return new RegExp(`[\\w@.\\-]+\\.(?:${extensions.join('|')})\\b`, 'gi');
}

/**
 * Sweep both haystacks for the names of assets nothing references.
 *
 * Does no IO at all when every asset is referenced, which is the common case on a
 * healthy repository.
 */
export async function sweepForMentions(options: SweepOptions): Promise<SweepResult> {
  const { graph } = options;
  const candidates = candidateBasenames(graph);
  const mentions = new Map<string, Mention[]>();
  const skipped: SweepSkip[] = [];

  if (candidates.size === 0) return { mentions, skipped };

  await sweepUnscannedFiles(options, candidates, mentions, skipped);
  await sweepUnresolvedReferences(options, candidates, mentions, skipped);

  for (const list of mentions.values()) list.sort(byWhereThenQuote);
  return { mentions, skipped };
}

/**
 * Assets with zero references, indexed by lowercased basename.
 *
 * A basename rather than a path because that is all an unread file gives us: a
 * `.vue` template says `hero.png`, not where it lives. Two assets sharing a
 * basename are therefore both hedged — the evidence genuinely cannot tell them
 * apart, and hedging is the safe direction to be wrong in.
 *
 * Lowercased for the same reason: Windows filesystems are case-insensitive, so a
 * template saying `Hero.PNG` really does refer to `hero.png` there.
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

/** Haystack (a): the text of every file no adapter read. */
async function sweepUnscannedFiles(
  options: SweepOptions,
  candidates: ReadonlyMap<string, readonly string[]>,
  mentions: Map<string, Mention[]>,
  skipped: SweepSkip[],
): Promise<void> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  for (const file of options.graph.unscannedFiles) {
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
        reason: `larger than the ${maxBytes}-byte sweep limit`,
      });
      continue;
    }

    for (const [token, index] of tokens(text)) {
      for (const asset of candidates.get(token.toLowerCase()) ?? []) {
        record(mentions, {
          asset,
          source: 'unscanned-file',
          where: `${file.relative}:${lineOf(text, index)}`,
          quote: token,
        });
      }
    }
  }
}

/**
 * Haystack (b): paths we read but could not resolve.
 *
 * Searching these costs no IO — the strings are already in the graph — but R10
 * makes the citation mandatory, and a line costs a re-read. `citeReferences` does
 * that once per file, and only for references that actually named a candidate.
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
  // A file we cannot re-read loses the line, not the citation (rule 9).
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
 * The references whose target is unknown.
 *
 * Kept here rather than at the call site so the R10 principle is stated once. An
 * eighth resolution outcome will not be added to this list by accident, because
 * `byResolution` will fail to compile first.
 */
function unknownTargetReferences(graph: Graph): readonly Reference[] {
  return [
    ...graph.byResolution.dynamic,
    ...graph.byResolution['unresolved-alias'],
    ...graph.byResolution.discarded,
  ];
}

/** Every filename-shaped token in a string, with the offset it started at. */
function* tokens(text: string): Generator<[string, number]> {
  // A fresh RegExp per call: a `g`-flagged literal carries `lastIndex` between
  // calls, which would make results depend on what was scanned before them.
  const pattern = filenamePattern();
  let match = pattern.exec(text);
  while (match !== null) {
    yield [match[0], match.index];
    match = pattern.exec(text);
  }
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
