/**
 * A parse failure as one sentence of ours for the report, with the parser's own text kept
 * apart for a diagnostic channel.
 *
 * A library's error text does not belong in the report: it describes the library rather
 * than what Upfly did, and it changes when the dependency is upgraded. In PostCSS's
 * `<css input>:144:13: Unknown word /`, only the position helps a reader, so the position
 * is kept and the wording replaced. The position comes from the error's structured
 * fields, never from parsing its message, so a reworded message leaves our sentence alone.
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
 * The caller states it rather than it being guessed from the error's shape, because the
 * two differ invisibly: PostCSS puts a 1-based `line` and `column` on the error, and
 * Babel puts `loc: { line, column }` with a 0-based column. Read the wrong way, every
 * JavaScript failure would be reported one column to the left, a wrong number that looks
 * right. Each adapter knows which parser it ran.
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
 * `dialect` names the syntax the file was read as (`css`, `scss`, `less`, `JavaScript`),
 * not what the file is, because when those differ that is the finding: a `.css` file
 * holding ERB is not broken CSS but a file read as the wrong thing.
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
