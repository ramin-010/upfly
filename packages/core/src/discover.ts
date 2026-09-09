/**
 * Walk a project and find its images and its adapter-claimed source files.
 *
 * This is one of only two modules in the engine allowed to touch the filesystem
 * (`execute` is the other). Everything downstream — resolution, the graph, the
 * audit, the planner — is a pure function over what this returns, which is what
 * lets the rest of the engine be tested without a disk.
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
import type { Adapter, Asset, DiscoveryResult, SkippedEntry, SourceFile } from './types.js';

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
    ignoredCount: 0,
  };
  const rules = await loadIgnoreRules(root, options, state);

  await walk({ root, rules, claimedExtensions, concurrency, state });
  const assets = await sizeAssets(state.assetCandidates, concurrency, root, state);

  return {
    root,
    assets: assets.sort(byRelativePath),
    sourceFiles: state.sourceFiles.sort(byRelativePath),
    ignoredCount: state.ignoredCount,
    skipped: state.skipped.sort(byRelativePath),
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

async function loadIgnoreRules(
  root: string,
  options: DiscoverOptions,
  state: WalkState,
): Promise<Ignore> {
  const rules = ignore();
  if (options.extraIgnores !== undefined) rules.add([...options.extraIgnores]);

  const fileName = options.ignoreFile ?? IGNORE_FILE_NAME;
  const filePath = join(root, fileName);
  try {
    rules.add(await readFile(filePath, 'utf8'));
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
  return rules;
}

interface WalkInput {
  readonly root: string;
  readonly rules: Ignore;
  readonly claimedExtensions: ReadonlyMap<string, string>;
  readonly concurrency: number;
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
    // `ignore` matches a `build/`-style pattern only when the path it is given ends
    // in a slash; testing 'build' returns false and we would descend into it.
    if (DEFAULT_IGNORED_DIRECTORY_SET.has(entry.name) || input.rules.ignores(`${relative}/`)) {
      input.state.ignoredCount += 1;
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

  if (input.rules.ignores(relative)) {
    input.state.ignoredCount += 1;
    return;
  }

  const extension = extensionOf(entry.name);
  if (isImageExtension(extension)) {
    input.state.assetCandidates.push({ path, relative, extension });
    return;
  }

  const adapterId = input.claimedExtensions.get(extension);
  if (adapterId !== undefined) {
    input.state.sourceFiles.push({ path, relative, extension, adapterId });
  }
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
