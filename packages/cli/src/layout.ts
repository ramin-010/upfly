/**
 * How the CLI lays out its own text: a headline, then labelled rows in sections, with labels
 * and values in columns and no line wider than 80 columns. A long path is shortened in the
 * middle rather than wrapped; a sentence is wrapped at its spaces.
 */

import type { Styles } from './output.js';

/** The widest line the CLI prints in its summaries. */
export const WIDTH = 80;

/** Labels sit two columns in and are padded to the longest, `Full report`. */
const LABEL_INDENT = 2;
const LABEL_WIDTH = 11;
const VALUE_COLUMN = LABEL_INDENT + LABEL_WIDTH + 2;
/** Lines under a value sit two columns further in. */
const DETAIL_COLUMN = VALUE_COLUMN + 2;

/** A piece of a value, and whether it is a total, which is printed in bold. */
export type Span = string | { readonly bold: string };

/** One labelled row: its value, and the lines under it. */
export interface Row {
  readonly label: string;
  readonly value: readonly Span[];
  /** Counts with what each counts, as a column of numbers under the value. */
  readonly counts?: readonly { readonly count: number; readonly text: string }[];
  /** Secondary lines under the value, dimmed. */
  readonly details?: readonly string[];
}

/** What a command prints by default: a headline, sections of rows, and a closing sentence. */
export interface Summary {
  /** The command, after `Upfly` in the headline. */
  readonly command: string;
  /** What kind of run it was, such as `dry run`, after the command. */
  readonly mode?: string;
  /** Groups of rows, with a blank line between groups. */
  readonly sections: readonly (readonly Row[])[];
  /** A last line, under everything else. */
  readonly closing?: string;
}

/**
 * The headline every command prints first: the name in the brand's colour, then the command,
 * then the kind of run.
 *
 * @example headline(styles, 'optimize', 'dry run') // "Upfly optimize · dry run"
 */
export function headline(styles: Styles, command: string, mode?: string): string {
  return `${styles.accent('Upfly')} ${command}${mode === undefined ? '' : styles.dim(` · ${mode}`)}`;
}

/**
 * The summary as text, ending in a newline.
 *
 * @param summary what to print
 * @param styles the colours, or none
 */
export function renderSummary(summary: Summary, styles: Styles): string {
  const lines = [headline(styles, summary.command, summary.mode), ''];
  for (const section of summary.sections) {
    if (section.length === 0) continue;
    for (const row of section) lines.push(...rowLines(row, styles));
    lines.push('');
  }
  if (summary.closing !== undefined) {
    for (const line of wrap(summary.closing, WIDTH - LABEL_INDENT)) {
      lines.push(`${' '.repeat(LABEL_INDENT)}${line}`);
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function rowLines(row: Row, styles: Styles): string[] {
  const label = `${' '.repeat(LABEL_INDENT)}${styles.accent(row.label)}${' '.repeat(VALUE_COLUMN - LABEL_INDENT - columns(row.label))}`;
  const plain = row.value.map(textOf).join('');
  const lines: string[] = [];
  if (columns(plain) <= WIDTH - VALUE_COLUMN) {
    lines.push(
      `${label}${row.value.map((span) => (typeof span === 'string' ? span : styles.bold(span.bold))).join('')}`,
    );
  } else {
    // Too long for one line: wrapped as plain text, since a total cut in two reads worse
    // than one that is not bold.
    const [first = '', ...rest] = wrap(plain, WIDTH - VALUE_COLUMN);
    lines.push(`${label}${first}`, ...rest.map((line) => `${' '.repeat(VALUE_COLUMN)}${line}`));
  }

  const counts = row.counts ?? [];
  const digits = Math.max(0, ...counts.map(({ count }) => String(count).length));
  for (const { count, text } of counts) {
    const number = String(count).padStart(digits);
    const [first = '', ...rest] = wrap(text, WIDTH - DETAIL_COLUMN - digits - 2);
    lines.push(styles.dim(`${' '.repeat(DETAIL_COLUMN)}${number}  ${first}`));
    for (const line of rest)
      lines.push(styles.dim(`${' '.repeat(DETAIL_COLUMN + digits + 2)}${line}`));
  }
  for (const detail of row.details ?? []) {
    for (const line of wrap(detail, WIDTH - DETAIL_COLUMN)) {
      lines.push(styles.dim(`${' '.repeat(DETAIL_COLUMN)}${line}`));
    }
  }
  return lines;
}

function textOf(span: Span): string {
  return typeof span === 'string' ? span : span.bold;
}

/**
 * How many columns a terminal gives `text`. East Asian wide characters take two and
 * combining marks none; this covers the common ranges, not every rule of Unicode's width
 * tables.
 */
export function columns(text: string): number {
  let width = 0;
  for (const char of text) width += charColumns(char.codePointAt(0) ?? 0);
  return width;
}

function charColumns(code: number): number {
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0;
  if (code >= 0x300 && code <= 0x36f) return 0;
  return WIDE.some(([from, to]) => code >= from && code <= to) ? 2 : 1;
}

const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];

/**
 * `text` cut to `width` columns by taking out its middle, where a path is least telling:
 * the start says where it is and the end names the file.
 *
 * @example shortenMiddle('src/components/gallery/images/hero.png', 20) // "src/compo…/hero.png"
 */
export function shortenMiddle(text: string, width: number): string {
  if (columns(text) <= width) return text;
  const chars = [...text];
  const room = Math.max(width - 1, 0);
  const headRoom = Math.ceil(room / 2);
  let head = '';
  for (const char of chars) {
    if (columns(head + char) > headRoom) break;
    head += char;
  }
  let tail = '';
  for (const char of chars.reverse()) {
    if (columns(char + tail) > room - columns(head)) break;
    tail = char + tail;
  }
  return `${head}…${tail}`;
}

/**
 * A sentence broken at its spaces into lines of at most `width` columns. A word wider than a
 * line, such as a long path, is shortened in the middle rather than broken.
 */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ').map((each) => shortenMiddle(each, width))) {
    if (line === '') line = word;
    else if (columns(line) + 1 + columns(word) <= width) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  lines.push(line);
  return lines;
}

/**
 * A command a user can copy into a shell, or null when a word in it cannot be quoted the same
 * way for every common shell. A word with anything but letters, digits and `_@%+=:,./-` is
 * put in double quotes, which bash, zsh, PowerShell and cmd all read; one holding a double
 * quote, `$` or a backquote, or ending in a backslash, has no such spelling.
 *
 * @example commandLine(['upfly', 'optimize', 'my site', '--apply']) // 'upfly optimize "my site" --apply'
 */
export function commandLine(words: readonly string[]): string | null {
  const quoted: string[] = [];
  for (const word of words) {
    if (/^[\w@%+=:,./-]+$/.test(word)) quoted.push(word);
    else if (/["$`]|\\$/.test(word) || word === '') return null;
    else quoted.push(`"${word}"`);
  }
  return quoted.join(' ');
}

/** The widest a value may be on its line. */
export const VALUE_WIDTH = WIDTH - VALUE_COLUMN;
