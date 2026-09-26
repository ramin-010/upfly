/**
 * Walk a project and find its images and its adapter-claimed source files.
 *
 * One of the few modules that touch the disk: the stages after it are pure functions of
 * what it returns or of an injected port. It also records every file no adapter claims,
 * which the audit sweeps for the names of unreferenced assets before calling one dead.
 *
 * A hand-written walker rather than a glob library, because the speed comes from never
 * entering directories such as `node_modules`, not from faster matching. See "Discovery"
 * in ARCHITECTURE.md.
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
 * A name lookup rather than an ignore pattern, because it runs for every directory in the
 * repository. Only dependency, cache, build-output and version-control directories, and
 * Upfly's own `.upfly`: nothing a user keeps a source image in.
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
 * How many directory reads, or image `stat` calls, run at once by default.
 *
 * The work is IO-bound, so the limit is there to avoid exhausting file descriptors, not
 * to match the number of cores.
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
  /** Directories read, and images sized, in parallel. Defaults to 16. */
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
  readonly directories: string[];
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
    directories: [],
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
    directories: state.directories.sort(compareStrings),
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
 * Two adapters claiming `.md` would make the winner depend on array order, so an overlap
 * is an error a contributor sees at once rather than a silent choice.
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
 * `ignore` reports whether a path matches but not which pattern did, so the patterns are
 * kept to let the report say "excluded by `legacy/`" rather than "excluded by a rule".
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
 * A shared work queue would parallelise slightly better near the top of the tree, but
 * needs bookkeeping so that no worker exits while another is still producing work.
 * Levels keep it simple: each goes out as batched `Promise.all`s, and the directories
 * found become the next level.
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
      // these, so a path into an excluded directory is reported as `out-of-scope`
      // rather than `broken`.
      input.state.excludedRoots.push({ path, relative, reason });
      return;
    }
    nextLevel.push(path);
    // Recorded here rather than derived later from the file paths: a directory
    // holding only files nothing tracks leaves no trace in the asset or source
    // lists, and serving-root detection needs the directory itself.
    input.state.directories.push(relative);
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
    // An SVG is an asset and a container. `<image href>`, `<use href>` and a `<style>`
    // block inside one are real references that no adapter reads, so it is also a file
    // we did not scan. Recording it stops an asset mentioned only inside an icon sprite
    // from being called dead.
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

  // Everything else was claimed by nobody and never read. The path is kept, not only a
  // count per extension, because the audit's sweep reads these files.
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
