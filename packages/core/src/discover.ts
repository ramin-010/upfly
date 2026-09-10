/**
 * Walk a project and find its images and its adapter-claimed source files.
 *
 * This is one of only three modules in the engine allowed to touch the filesystem
 * (the `ImageProbe` implementation and `execute` are the others). Everything
 * downstream — scanning, resolution, the graph, the audit, the planner — is a pure
 * function over what this returns or over an injected port, which is what lets the
 * rest of the engine be tested without a disk.
 *
 * It also records what it did *not* read: every file no adapter claims lands in
 * `unscannedFiles` with its path. The audit sweeps those for the filenames of
 * zero-reference assets, so a `dead` finding can be made confidently instead of
 * hedged globally.
 *
 * Why a hand-written walker rather than a glob library: the performance budget is
 * won by *pruning*, not by matching. A repo's `node_modules` holds more files than
 * everything else combined, and the only way to stay under the budget is to never
 * descend into it. A glob has to consider each path in order to reject it; we drop
 * the whole subtree on a single directory-name lookup. Walking also lets us take
 * the one `stat` we need in the same pass instead of a second one later.
 */

import type { Dirent } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { UpflyError } from './errors.js';
import { compareStrings, extensionOf, isImageExtension, relativePath } from './paths.js';
import type {
  Adapter,
  Asset,
  DiscoveryResult,
  ExcludedRoot,
  SkippedEntry,
  SourceFile,
  UnscannedFile,
} from './types.js';

/**
 * Directory names never descended into, matched by name at any depth.
 *
 * A plain name lookup rather than an ignore pattern because this is the hot path:
 * it runs once per directory entry in the repo. These are version-control and
 * build-output directories only — nothing a user keeps a source image in.
 */
export const DEFAULT_IGNORED_DIRECTORIES: readonly string[] = Object.freeze([
  '.astro',
  '.cache',
  '.git',
  '.next',
  '.nuxt',
  '.output',
  '.parcel-cache',
  '.svelte-kit',
  '.turbo',
  '.upfly',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
]);

const DEFAULT_IGNORED_DIRECTORY_SET = new Set(DEFAULT_IGNORED_DIRECTORIES);

/** Default name of the per-project ignore file, read from the root only. */
export const IGNORE_FILE_NAME = '.upflyignore';

/**
 * How many directories are read concurrently.
 *
 * Directory reads are IO-bound, so this is deliberately higher than the core
 * count — the limit exists to avoid exhausting file descriptors, not to match CPUs.
 */
const DEFAULT_CONCURRENCY = 16;

export interface DiscoverOptions {
  /** Project root. A relative path is resolved against `process.cwd()`. */
  readonly root: string;
  /** Adapters whose extensions define what counts as a source file. */
  readonly adapters: readonly Adapter[];
  /** Ignore-file name, relative to the root. Defaults to `.upflyignore`. */
  readonly ignoreFile?: string;
  /** Extra gitignore-syntax patterns, applied as if appended to the ignore file. */
  readonly extraIgnores?: readonly string[];
  /** Directories read in parallel. Defaults to 16. */
  readonly concurrency?: number;
}

/** An image file found during the walk, before its size is known. */
interface AssetCandidate {
  readonly path: string;
  readonly relative: string;
  readonly extension: string;
}

/** Everything the walk accumulates. Mutable by design; it never escapes this module. */
interface WalkState {
  readonly assetCandidates: AssetCandidate[];
  readonly sourceFiles: SourceFile[];
  readonly skipped: SkippedEntry[];
  readonly excludedRoots: ExcludedRoot[];
  readonly unscannedFiles: UnscannedFile[];
  ignoredCount: number;
}

/**
 * Find every image and every adapter-claimed source file under `root`.
 *
 * @throws {UpflyError} `ROOT_NOT_A_DIRECTORY` if the root is missing or is a file.
 * @throws {UpflyError} `ADAPTER_EXTENSION_CONFLICT` if two adapters claim one extension.
 */
export async function discover(options: DiscoverOptions): Promise<DiscoveryResult> {
  const root = resolvePath(options.root);
  await assertDirectory(root);

  const claimedExtensions = mapExtensionsToAdapters(options.adapters);
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const state: WalkState = {
    assetCandidates: [],
    sourceFiles: [],
    skipped: [],
    excludedRoots: [],
    unscannedFiles: [],
    ignoredCount: 0,
  };
  const ignoreFileName = options.ignoreFile ?? IGNORE_FILE_NAME;
  const ignoreFilePath = join(root, ignoreFileName);
  const rules = await loadIgnoreRules(ignoreFilePath, ignoreFileName, options, state);

  await walk({ root, rules, claimedExtensions, concurrency, ignoreFilePath, state });
  const assets = await sizeAssets(state.assetCandidates, concurrency, root, state);

  return {
    root,
    assets: assets.sort(byRelativePath),
    sourceFiles: state.sourceFiles.sort(byRelativePath),
    ignoredCount: state.ignoredCount,
    skipped: state.skipped.sort(byRelativePath),
    excludedRoots: state.excludedRoots.sort(byRelativePath),
    unscannedFiles: state.unscannedFiles.sort(byRelativePath),
  };
}

async function assertDirectory(root: string): Promise<void> {
  try {
    const stats = await stat(root);
    if (!stats.isDirectory()) {
      throw new UpflyError('ROOT_NOT_A_DIRECTORY', `Not a directory: ${root}`);
    }
  } catch (error) {
    if (error instanceof UpflyError) throw error;
    throw new UpflyError(
      'ROOT_NOT_A_DIRECTORY',
      `Cannot read directory ${root} (${errnoCode(error)}).`,
    );
  }
}

/**
 * Build the extension to adapter lookup, rejecting overlaps.
 *
 * Two adapters claiming `.md` would make the winner depend on array order, which
 * is exactly the kind of quiet non-determinism a contribution surface should not
 * have. Failing loudly here costs a contributor one clear error message.
 */
function mapExtensionsToAdapters(adapters: readonly Adapter[]): ReadonlyMap<string, string> {
  const claimed = new Map<string, string>();
  for (const adapter of adapters) {
    for (const extension of adapter.extensions) {
      const existing = claimed.get(extension);
      if (existing !== undefined) {
        throw new UpflyError(
          'ADAPTER_EXTENSION_CONFLICT',
          `Adapters ${existing} and ${adapter.id} both claim ${extension}.`,
        );
      }
      claimed.set(extension, adapter.id);
    }
  }
  return claimed;
}

/**
 * The compiled ignore matcher, plus the patterns it was built from.
 *
 * The patterns are kept so that an excluded directory can name the rule that
 * excluded it. `ignore` reports *whether* a path matches but not *which* pattern
 * did, and "excluded by some rule you wrote" is a much worse report line than
 * "excluded by `legacy/`" when someone is working out why their asset vanished.
 */
interface IgnoreRules {
  readonly matcher: Ignore;
  readonly patterns: readonly string[];
}

async function loadIgnoreRules(
  filePath: string,
  fileName: string,
  options: DiscoverOptions,
  state: WalkState,
): Promise<IgnoreRules> {
  const patterns: string[] = [];
  const rules = ignore();
  if (options.extraIgnores !== undefined) {
    rules.add([...options.extraIgnores]);
    patterns.push(...options.extraIgnores);
  }

  try {
    const contents = await readFile(filePath, 'utf8');
    rules.add(contents);
    patterns.push(...usablePatterns(contents));
  } catch (error) {
    // Having no ignore file is the normal case, not something to report.
    const code = errnoCode(error);
    if (code !== 'ENOENT') {
      state.skipped.push({
        path: filePath,
        relative: fileName,
        reason: 'unreadable-file',
        detail: code,
      });
    }
  }
  return { matcher: rules, patterns };
}

/**
 * Why this directory is excluded, or `null` if it is not.
 *
 * `ignore` matches a `build/`-style pattern only when the path it is given ends in a
 * slash; testing 'build' returns false and we would descend into it.
 */
function exclusionReasonFor(name: string, relative: string, rules: IgnoreRules): string | null {
  if (DEFAULT_IGNORED_DIRECTORY_SET.has(name)) {
    return `a build or version-control directory named '${name}'`;
  }
  if (!rules.matcher.ignores(`${relative}/`)) return null;

  const pattern = excludingPattern(rules, `${relative}/`);
  return pattern === null ? 'an ignore rule' : `the ignore rule '${pattern}'`;
}

/** Pattern lines from an ignore file, minus blanks and comments. */
function usablePatterns(contents: string): string[] {
  return contents
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/**
 * Which pattern excluded this path.
 *
 * Gitignore semantics are last-match-wins, so the last matching pattern is the one
 * that decided. Only ever called for a path already known to be excluded, and only
 * for directories, so the cost is a handful of matches per run.
 */
function excludingPattern(rules: IgnoreRules, relative: string): string | null {
  let matched: string | null = null;
  for (const pattern of rules.patterns) {
    if (ignore().add(pattern).ignores(relative)) matched = pattern;
  }
  return matched;
}

interface WalkInput {
  readonly root: string;
  readonly rules: IgnoreRules;
  readonly claimedExtensions: ReadonlyMap<string, string>;
  readonly concurrency: number;
  /** The ignore file we already read. Not a file we failed to scan. */
  readonly ignoreFilePath: string;
  readonly state: WalkState;
}

/**
 * Breadth-first, one level at a time, reading up to `concurrency` directories at once.
 *
 * Level-by-level rather than a shared work queue because it is obvious: every
 * directory in a level is independent, so a level goes out as batched `Promise.all`s
 * and the child directories become the next level. A work queue would parallelise
 * marginally better at the very top of the tree, but needs active-worker bookkeeping
 * to avoid workers exiting while a peer is still producing work — not a trade worth
 * making in a module that has to stay explainable.
 */
async function walk(input: WalkInput): Promise<void> {
  let level = [input.root];

  while (level.length > 0) {
    const nextLevel: string[] = [];

    for (let index = 0; index < level.length; index += input.concurrency) {
      const batch = level.slice(index, index + input.concurrency);
      const reads = await Promise.all(batch.map((directory) => readDirectory(directory, input)));

      for (const read of reads) {
        for (const entry of read.entries) {
          classifyEntry(entry, read.directory, input, nextLevel);
        }
      }
    }

    level = nextLevel;
  }
}

interface DirectoryRead {
  readonly directory: string;
  readonly entries: readonly Dirent[];
}

async function readDirectory(directory: string, input: WalkInput): Promise<DirectoryRead> {
  try {
    return { directory, entries: await readdir(directory, { withFileTypes: true }) };
  } catch (error) {
    input.state.skipped.push({
      path: directory,
      relative: relativePath(input.root, directory),
      reason: 'unreadable-directory',
      detail: errnoCode(error),
    });
    return { directory, entries: [] };
  }
}

/**
 * Decide what one directory entry is: ignored, skipped, an asset, a source file, a
 * directory to descend into, or nothing we care about.
 */
function classifyEntry(
  entry: Dirent,
  directory: string,
  input: WalkInput,
  nextLevel: string[],
): void {
  const path = join(directory, entry.name);
  const relative = relativePath(input.root, path);

  // Checked before isDirectory/isFile: on Windows a junction reports as a symlink
  // here, and following one can put the walk into a cycle or outside the root.
  if (entry.isSymbolicLink()) {
    input.state.skipped.push({ path, relative, reason: 'symlink', detail: 'not followed' });
    return;
  }

  if (entry.isDirectory()) {
    const reason = exclusionReasonFor(entry.name, relative, input.rules);
    if (reason !== null) {
      input.state.ignoredCount += 1;
      // Recorded, not merely counted: the resolver prefix-tests references against
      // these so that a path into an excluded directory is reported as
      // `out-of-scope` rather than as a broken reference that does not exist.
      input.state.excludedRoots.push({ path, relative, reason });
      return;
    }
    nextLevel.push(path);
    return;
  }

  if (!entry.isFile()) {
    input.state.skipped.push({
      path,
      relative,
      reason: 'not-a-regular-file',
      detail: 'neither a file nor a directory',
    });
    return;
  }

  if (input.rules.matcher.ignores(relative)) {
    input.state.ignoredCount += 1;
    return;
  }

  const extension = extensionOf(entry.name);
  if (isImageExtension(extension)) {
    input.state.assetCandidates.push({ path, relative, extension });
    // An SVG is an asset *and* a container. `<image href>`, `<use href>` and a
    // `<style>` block inside one are all real references, and no adapter reads
    // them — so it is also a file we did not scan. Recording it is what stops an
    // asset mentioned only inside an icon sprite being called confidently dead.
    if (extension === SVG_EXTENSION) {
      input.state.unscannedFiles.push(unclaimed(path, relative, extension));
    }
    return;
  }

  const adapterId = input.claimedExtensions.get(extension);
  if (adapterId !== undefined) {
    input.state.sourceFiles.push({ path, relative, extension, adapterId });
    return;
  }

  // Our own ignore file is the one unclaimed file we did read. Listing it under
  // "files Upfly could not read" would make the tool look confused about itself.
  if (path === input.ignoreFilePath) return;

  // Everything else: enumerated, claimed by nobody, therefore never read. The audit
  // sweeps these for the filenames of zero-reference assets, which is why the path
  // is kept rather than only a count per extension.
  input.state.unscannedFiles.push(unclaimed(path, relative, extension));
}

/** The one image format that can itself reference other assets. */
const SVG_EXTENSION = '.svg';

function unclaimed(path: string, relative: string, extension: string): UnscannedFile {
  return { path, relative, extension, reason: 'unclaimed-extension', detail: '' };
}

/**
 * Attach a size to every image found.
 *
 * Kept out of the walk so that traversal stays about traversal. The cost is the
 * same either way: one `stat` per image, batched the same way.
 */
async function sizeAssets(
  candidates: readonly AssetCandidate[],
  concurrency: number,
  root: string,
  state: WalkState,
): Promise<Asset[]> {
  const assets: Asset[] = [];

  for (let index = 0; index < candidates.length; index += concurrency) {
    const batch = candidates.slice(index, index + concurrency);
    const sized = await Promise.all(batch.map(sizeAsset));

    for (const result of sized) {
      if (result.asset !== null) {
        assets.push(result.asset);
      } else {
        state.skipped.push({
          path: result.candidate.path,
          relative: relativePath(root, result.candidate.path),
          reason: 'unreadable-file',
          detail: result.detail,
        });
      }
    }
  }

  return assets;
}

interface SizedAsset {
  readonly candidate: AssetCandidate;
  readonly asset: Asset | null;
  readonly detail: string;
}

async function sizeAsset(candidate: AssetCandidate): Promise<SizedAsset> {
  try {
    const stats = await stat(candidate.path);
    return {
      candidate,
      asset: {
        path: candidate.path,
        relative: candidate.relative,
        extension: candidate.extension,
        bytes: stats.size,
      },
      detail: '',
    };
  } catch (error) {
    return { candidate, asset: null, detail: errnoCode(error) };
  }
}

function byRelativePath(a: { relative: string }, b: { relative: string }): number {
  return compareStrings(a.relative, b.relative);
}

/** Pull the errno string off a filesystem rejection without asserting its shape. */
function errnoCode(error: unknown): string {
  if (error instanceof Error && 'code' in error) {
    const { code } = error as Error & { code?: unknown };
    if (typeof code === 'string') return code;
  }
  return 'UNKNOWN';
}
