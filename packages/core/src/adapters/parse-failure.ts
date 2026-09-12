/**
 * One sentence about a parse failure, written by us — and the parser's own words
 * sent somewhere that is not a report.
 *
 * **R60, applied to the parsers rather than to the imaging library.** The ruling is
 * that a third-party library's error text must never reach a rule-11 artefact: it is
 * not ours, it describes the library rather than describing what Upfly did, and it
 * changes on a dependency upgrade. Measured on `railsgirls-com`, 23 `scan` skips
 * carried PostCSS's wording verbatim — `<css input>:144:13: Unknown word /` — where
 * `<css input>` is PostCSS's placeholder for a file we did in fact name, `Unknown
 * word` is PostCSS's vocabulary, and only the `144:13` was ever any use to a reader.
 *
 * So the position is kept and the wording is replaced. **Kept from the parser's
 * structured fields, never by parsing its message**, which is the whole point: a
 * major version is free to reword `Unknown word` and our sentence does not move.
 *
 * ⚠️ **Both parsers are covered even though only one of them was ever seen.** The
 * JavaScript adapter reaches Babel's raw text through a `?? detail` fallback that the
 * corpus happens never to enter — every JS parse failure across the five repositories
 * is the Nunjucks/Jinja case, which already had a sentence of ours. A defect with no
 * instances is still the defect; this is R63's lesson, where the same wrong answer
 * lived in `plan.ts` and nobody had asked.
 */

/** What a parse failure becomes: our sentence, and the library's, kept apart. */
export interface ParseFailure {
  /** Ours. This is what reaches the report. */
  readonly message: string;
  /**
   * The parser's own text, verbatim.
   *
   * Carried on the thrown `UpflyError` and read off it by `scan`, which hands it to a
   * diagnostic channel. It is never a field on `UnscannedFile`, so no renderer and no
   * sort can reach it.
   */
  readonly diagnostic: string;
}

/**
 * Where each parser puts a position, and what its column counts from.
 *
 * ⚠️ **Stated by the caller rather than sniffed from the error, because the two
 * disagree and the disagreement is invisible.** PostCSS puts a 1-based `line` and
 * `column` on the error itself; Babel puts `loc: { line, column }` where the column
 * is **0-based**. Duck-typing would have read Babel's column as PostCSS's and
 * reported every JavaScript failure one column to the left — a wrong number that
 * looks exactly like a right one. Each adapter knows which parser it ran.
 */
export type PositionStyle = 'postcss' | 'babel';

interface Position {
  readonly line: number;
  /** 1-based, whatever the parser counted from. */
  readonly column: number;
}

function positionOf(error: unknown, style: PositionStyle): Position | null {
  if (typeof error !== 'object' || error === null) return null;

  if (style === 'postcss') {
    const { line, column } = error as { line?: unknown; column?: unknown };
    if (typeof line !== 'number' || typeof column !== 'number') return null;
    return { line, column };
  }

  const { loc } = error as { loc?: unknown };
  if (typeof loc !== 'object' || loc === null) return null;
  const { line, column } = loc as { line?: unknown; column?: unknown };
  if (typeof line !== 'number' || typeof column !== 'number') return null;
  // Babel counts columns from zero. The report counts from one, the way every editor
  // and every other citation in this codebase does.
  return { line, column: column + 1 };
}

/**
 * Our sentence for a parse failure, and the parser's text kept out of it.
 *
 * `dialect` is how the report should name the syntax we tried to read the file as —
 * `css`, `scss`, `less`, `JavaScript`. It names what we attempted rather than what
 * the file is, because when those differ that *is* the finding: a `.css` file holding
 * ERB is not broken CSS, it is a file we read as the wrong thing.
 */
export function parseFailure(input: {
  readonly error: unknown;
  readonly dialect: string;
  readonly position: PositionStyle;
}): ParseFailure {
  const { error, dialect, position } = input;
  const at = positionOf(error, position);
  const diagnostic = error instanceof Error ? error.message : String(error);

  return {
    message:
      at === null
        ? `Could not parse: the file is not valid ${dialect}`
        : `Could not parse: invalid ${dialect} syntax at line ${at.line}, column ${at.column}`,
    diagnostic,
  };
}
