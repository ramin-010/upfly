/**
 * Read every source file and hand it to the adapter that claimed it.
 *
 * Nothing owned this loop before, and that mattered: `css.ts` and `javascript.ts`
 * throw `ADAPTER_PARSE_FAILED` on a parse failure — correctly, since returning `[]`
 * would report a file full of references as clean — but a throw nobody catches means
 * one unparseable `.scss` in a five-thousand-file repository kills the whole audit.
 *
 * So this module owns error handling across every adapter, and a file it could not
 * read becomes a *reported* entry rather than an exception. That is rule 9 twice
 * over: the failure reaches the report, and it also feeds the audit's per-asset
 * sweep, because a file we could not parse is a file whose references we do not
 * know — exactly the same condition as an extension no adapter claims.
 *
 * `readFile` is injected rather than imported, the same shape as the resolver's
 * `exists` port and the `ImageProbe`. That keeps this module pure, keeps the count
 * of filesystem-touching modules at three, and lets the module that owns error
 * handling for every adapter be tested against an in-memory file map instead of a
 * temp tree full of deliberately broken files.
 *
 * It deliberately does *not* return the file texts. Holding an entire repository's
 * source in memory to save a later re-read would trade a bounded cost for an
 * unbounded one, and the only consumer that needs the text again — the rewrite in
 * Phase 2 — reads each file at the moment it edits it anyway.
 */

import { UpflyError } from './errors.js';
import type { Adapter, RawReference, SourceFile, UnscannedFile } from './types.js';

/**
 * Reads a file's text. Injected so this module stays pure.
 *
 * The real implementation is `(path) => readFile(path, 'utf8')`. Encoding is
 * deliberately the caller's concern: offsets are UTF-16 code units into whatever
 * string this returns, so as long as the same decoding is used to read and to
 * rewrite, a byte-order mark or an unusual encoding stays consistent.
 */
export type ReadFilePort = (absolutePath: string) => Promise<string>;

export interface ScanOptions {
  /** Files to read, as returned by `discover`. Output order follows this order. */
  readonly sourceFiles: readonly SourceFile[];
  /** The same adapters `discover` was given. Each `adapterId` must be among them. */
  readonly adapters: readonly Adapter[];
  readonly readFile: ReadFilePort;
  /** Files read in parallel. Defaults to 16. */
  readonly concurrency?: number;
}

export interface ScanResult {
  /** Every reference found, in source-file order and then in source order. */
  readonly references: readonly RawReference[];
  /**
   * Files an adapter claimed but that were never scanned.
   *
   * The same list shape `discover` produces for unclaimed extensions, because the
   * audit treats them identically: in both cases we did not learn what the file
   * references, so an asset named only there must not be reported as dead.
   */
  readonly unscanned: readonly UnscannedFile[];
}

/** How many files are read at once. IO-bound, so higher than the core count. */
const DEFAULT_CONCURRENCY = 16;

/**
 * Read and parse every source file.
 *
 * @throws {UpflyError} `ADAPTER_NOT_REGISTERED` if a file names an adapter that was
 * not supplied. That is a wiring mistake — scanning with a different adapter set
 * than discovery used — and it is loud on purpose: the quiet alternative is a file
 * silently going unread and an asset silently looking dead.
 */
export async function scanSources(options: ScanOptions): Promise<ScanResult> {
  const byId = new Map(options.adapters.map((adapter) => [adapter.id, adapter]));
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);

  const references: RawReference[] = [];
  const unscanned: UnscannedFile[] = [];
  const files = options.sourceFiles;

  for (let index = 0; index < files.length; index += concurrency) {
    const batch = files.slice(index, index + concurrency);
    // `Promise.all` preserves input order, so batching does not make the output
    // depend on which read finished first. Rule 11 needs that to be true by
    // construction rather than by a sort applied afterwards.
    const scanned = await Promise.all(
      batch.map((file) => scanOne(file, adapterFor(file, byId), options.readFile)),
    );

    for (const result of scanned) {
      if (result.failure === null) references.push(...result.references);
      else unscanned.push(result.failure);
    }
  }

  return { references, unscanned };
}

function adapterFor(file: SourceFile, byId: ReadonlyMap<string, Adapter>): Adapter {
  const adapter = byId.get(file.adapterId);
  if (adapter === undefined) {
    throw new UpflyError(
      'ADAPTER_NOT_REGISTERED',
      `${file.relative} was claimed by adapter '${file.adapterId}', which was not supplied to scanSources.`,
    );
  }
  return adapter;
}

interface ScannedFile {
  readonly references: readonly RawReference[];
  /** `null` when the file was read and parsed. */
  readonly failure: UnscannedFile | null;
}

async function scanOne(
  file: SourceFile,
  adapter: Adapter,
  readFile: ReadFilePort,
): Promise<ScannedFile> {
  let text: string;
  try {
    text = await readFile(file.path);
  } catch (error) {
    // A file that vanished or became unreadable between the walk and the read.
    // §5.1(e) requires exactly this to degrade rather than crash.
    return { references: [], failure: unscannedFile(file, 'unreadable', describe(error)) };
  }

  try {
    return { references: adapter.findReferences({ file: file.path, text }), failure: null };
  } catch (error) {
    // Every throw, not only `ADAPTER_PARSE_FAILED`. Adapters are the contribution
    // surface, and a bug in a community adapter must not take down an audit of a
    // repository that adapter barely touches. The message is carried into the
    // report, so a broken adapter is visible rather than merely survivable.
    return { references: [], failure: unscannedFile(file, 'parse-failed', describe(error)) };
  }
}

function unscannedFile(
  file: SourceFile,
  reason: 'parse-failed' | 'unreadable',
  detail: string,
): UnscannedFile {
  return {
    path: file.path,
    relative: file.relative,
    extension: file.extension,
    reason,
    detail,
  };
}

/** A one-line description of a failure, without asserting its shape. */
function describe(error: unknown): string {
  if (error instanceof UpflyError) return `${error.code}: ${error.message}`;
  if (error instanceof Error && 'code' in error) {
    const { code } = error as Error & { code?: unknown };
    if (typeof code === 'string') return code;
  }
  return error instanceof Error ? error.message : String(error);
}
