/**
 * Turns a reference's offset into a line a person can open.
 *
 * A reference carries a UTF-16 offset, which is what a rewrite needs, and `scan` does not
 * keep file texts, since holding a repository's source in memory to save a re-read trades a
 * bounded cost for an unbounded one. So a line costs a re-read, and this module reads each
 * file once however many references it cites. Both callers cite a bounded set: the audit
 * only broken references, the sweep only references that name an unreferenced asset.
 *
 * A file that cannot be re-read loses its line, not its citation, and the failure is
 * reported.
 */

import { compareStrings, relativePath } from '../paths.js';
import type { Reference } from '../types.js';
import type { ReadFilePort } from './scan.js';

/** Where a reference sits, as the report prints it. */
export interface Citation {
  /** POSIX-relative path of the source file. */
  readonly file: string;
  /** One-based line, or `null` when the file could not be re-read. */
  readonly line: number | null;
  /** `file:line`, or just `file` when there is no line. The report's string. */
  readonly where: string;
}

/** A source file the citation pass could not read. */
export interface UnreadableSource {
  /** POSIX-relative path. */
  readonly relative: string;
  readonly reason: string;
}

export interface CitationResult {
  /** Keyed by reference identity: the same objects that were passed in. */
  readonly citations: ReadonlyMap<Reference, Citation>;
  /** Files that could not be re-read, sorted by `relative`. */
  readonly unreadable: readonly UnreadableSource[];
}

export interface CitationOptions {
  readonly references: readonly Reference[];
  /** Absolute project root, for turning `Reference.file` into a report key. */
  readonly root: string;
  readonly readFile: ReadFilePort;
}

/** Cite every reference given, reading each source file at most once. */
export async function citeReferences(options: CitationOptions): Promise<CitationResult> {
  const citations = new Map<Reference, Citation>();
  const unreadable = await withSourceTexts(options, (file, text, references) => {
    for (const reference of references) {
      citations.set(reference, citationAt(file, text, reference.start));
    }
  });
  return { citations, unreadable };
}

/**
 * Read the file each reference sits in, once per file, and hand `cite` its text with the
 * references in it, or `null` for a file that could not be re-read. Returns those files,
 * sorted by `relative`.
 */
export async function withSourceTexts(
  options: CitationOptions,
  cite: (file: string, text: string | null, references: readonly Reference[]) => void,
): Promise<readonly UnreadableSource[]> {
  const byFile = new Map<string, Reference[]>();
  for (const reference of options.references) {
    const list = byFile.get(reference.file);
    if (list === undefined) byFile.set(reference.file, [reference]);
    else list.push(reference);
  }

  const unreadable: UnreadableSource[] = [];
  for (const [path, references] of byFile) {
    const file = relativePath(options.root, path);

    let text: string | null = null;
    try {
      text = await options.readFile(path);
    } catch (error) {
      unreadable.push({ relative: file, reason: describe(error) });
    }
    cite(file, text, references);
  }

  unreadable.sort((a, b) => compareStrings(a.relative, b.relative));
  return unreadable;
}

/** The citation of an offset in a file's text, or of the file alone when there is no text. */
export function citationAt(file: string, text: string | null, offset: number): Citation {
  const line = text === null ? null : lineOf(text, offset);
  return { file, line, where: line === null ? file : `${file}:${line}` };
}

/**
 * One-based line number of an offset.
 *
 * Counts `\n` only. A CRLF file has its newlines counted correctly because the `\n`
 * is still there, and a lone `\r` is not a line break in any editor that would be
 * opening this file.
 */
export function lineOf(text: string, offset: number): number {
  let line = 1;
  const limit = Math.min(offset, text.length);
  for (let index = 0; index < limit; index++) {
    if (text[index] === '\n') line += 1;
  }
  return line;
}

function describe(error: unknown): string {
  if (error instanceof Error && 'code' in error) {
    const { code } = error as Error & { code?: unknown };
    if (typeof code === 'string') return code;
  }
  return error instanceof Error ? error.message : String(error);
}
