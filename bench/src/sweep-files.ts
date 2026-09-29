/**
 * How the corpus checker's recall sweep reads a repository: which files it searches, and the
 * paths it compares with the ones the graph links.
 */

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** The largest file the sweep searches, in bytes as the file system counts them. */
export const MAX_SEARCHED_BYTES = 2_000_000;

/**
 * A file's text for the sweep, or undefined when it is larger than `MAX_SEARCHED_BYTES` or
 * cannot be read. The size is asked before the read, so a larger file is never read.
 */
export async function searchableText(file: string): Promise<string | undefined> {
  try {
    if ((await stat(file)).size > MAX_SEARCHED_BYTES) return undefined;
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * An asset's absolute path under `root`, joined segment by segment from its `/`-separated
 * relative path, so it equals the path the walk yields on every platform.
 */
export function assetPathUnder(root: string, relativePath: string, joinPath = join): string {
  return joinPath(root, ...relativePath.split('/'));
}
