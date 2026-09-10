/**
 * Turn a reference's offset into something a person can navigate to.
 *
 * `RawReference` carries `start` — a UTF-16 offset — because that is what a rewrite
 * needs and what every parser produces. A report needs a line, and nothing in the
 * engine holds one: `scan` deliberately does not retain file texts, since keeping a
 * whole repository's source in memory to save a later re-read trades a bounded cost
 * for an unbounded one.
 *
 * So a line costs a re-read, and this module makes that re-read happen **once per
 * file** rather than once per reference. Both callers are bounded before they get
 * here — the audit cites only broken references, the sweep only references that
 * named a zero-reference asset — so the set is tens of files, not thousands.
 *
 * A file that cannot be re-read loses its line, not its citation. The finding still
 * names the file and the path; rule 9 means the failure is reported rather than
 * making the reference quietly vanish from the report.
 */

import { compareStrings, relativePath } from './paths.js';
import type { ReadFilePort } from './scan.js';
import type { Reference } from './types.js';

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
  /** Keyed by reference identity — the same objects that were passed in. */
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
  const byFile = new Map<string, Reference[]>();
  for (const reference of options.references) {
    const list = byFile.get(reference.file);
    if (list === undefined) byFile.set(reference.file, [reference]);
    else list.push(reference);
  }

  const citations = new Map<Reference, Citation>();
  const unreadable: UnreadableSource[] = [];

  for (const [path, references] of byFile) {
    const file = relativePath(options.root, path);

    let text: string | null = null;
    try {
      text = await options.readFile(path);
    } catch (error) {
      unreadable.push({ relative: file, reason: describe(error) });
    }

    for (const reference of references) {
      const line = text === null ? null : lineOf(text, reference.start);
      citations.set(reference, {
        file,
        line,
        where: line === null ? file : `${file}:${line}`,
      });
    }
  }

  unreadable.sort((a, b) => compareStrings(a.relative, b.relative));
  return { citations, unreadable };
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
