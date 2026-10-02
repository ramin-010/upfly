/**
 * How the CLI lays out its own text: a headline, then labelled rows in sections, with labels
 * and values in columns and no line wider than 80 columns. A long path is shortened in the
 * middle rather than wrapped; a sentence is wrapped at its spaces. A value marked whole is
 * the one exception: it is printed on one line, however wide.
 *
 * The report file is the same summary with each row's complete list under it, and the
 * engine's caveats last; `--show` prints one row with its list.
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

/** One labelled row: its value, and the lines under it. */
export interface Row {
  readonly label: string;
  /** The value, in pieces printed one after another. */
  readonly value: readonly string[];
  /** Whether the value is printed in bold: only a command to run, so it can be copied. */
  readonly bold?: boolean;
  /**
   * Whether the value is printed on one line as it is, never wrapped or shortened: a path the
   * reader must see in full, such as the repository a commit is made in.
   */
  readonly whole?: boolean;
  /** Counts with what each counts, as a column of numbers under the value. */
  readonly counts?: readonly { readonly count: number; readonly text: string }[];
  /** Secondary lines under the value, dimmed. */
  readonly details?: readonly string[];
  /** The name `--show` takes for this row, when it has a list. */
  readonly key?: string;
  /** Whether the row is left out of the report file, as the row naming that file is. */
  readonly terminalOnly?: boolean;
  /**
   * Everything the row counts, in the report file and under `--show`: a sentence saying what
   * it lists and what to do, then one line per item.
   */
  readonly list?: RowList;
}

/** A row's complete list: what it is, then its items, which are never cut short. */
export interface RowList {
  /** What the list holds and what the reader can do about it, as sentences. */
  readonly intro: string;
  readonly items: readonly string[];
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
  /** The engine's caveats, for the end of the report file: a sentence, then its details. */
  readonly caveats?: readonly RowList[];
}

/** The first lines of a report file under its headline: when, where and with what. */
export interface FileHeader {
  /** The local date and time the run started, as `2026-10-02 19:42`. */
  readonly when: string;
  readonly folder: string;
  /** The options as they would be typed, without the folder. */
  readonly options: readonly string[];
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
  lines.push(...closingLines(summary));
  return spaced(lines);
}

/** The text with a blank line before it and after it, as every command prints its own. */
export function spaced(lines: readonly string[]): string {
  return `\n${lines.join('\n').trimEnd()}\n\n`;
}

function closingLines(summary: Summary): string[] {
  if (summary.closing === undefined) return [];
  return [...wrap(summary.closing, WIDTH - LABEL_INDENT).map((line) => `  ${line}`), ''];
}

/**
 * The report file: the headline, when, where and with what options, then the summary's rows
 * in the same order with each row's complete list under it, and the engine's caveats last.
 *
 * @param summary the summary the terminal shows, with its lists
 * @param header when the run started, its folder and its options
 */
export function renderFile(summary: Summary, header: FileHeader): string {
  const lines = [
    headline(PLAIN_STYLES, summary.command, summary.mode),
    `Run ${header.when} in ${header.folder}`,
    `Options: ${header.options.length === 0 ? 'none' : header.options.join(' ')}`,
    '',
  ];
  for (const section of summary.sections) {
    if (section.length === 0) continue;
    for (const row of section) {
      if (row.terminalOnly === true) continue;
      lines.push(...rowLines(row, PLAIN_STYLES));
      if (row.list !== undefined) lines.push('', ...listLines(row.list), '');
    }
    if (lines.at(-1) !== '') lines.push('');
  }
  lines.push(...closingLines(summary));
  const caveats = summary.caveats ?? [];
  if (caveats.length > 0) {
    lines.push('What Upfly could not check', '');
    for (const caveat of caveats) lines.push(...listLines(caveat, 2), '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * One row and its complete list, as the report file holds them, or null when no row of the
 * summary has that name.
 *
 * @param summary the summary the terminal shows, with its lists
 * @param key the row's name, as `--show` takes it
 */
export function renderSection(summary: Summary, key: string): string | null {
  const row = summary.sections.flat().find((each) => each.key === key);
  if (row === undefined) return null;
  return spaced([
    ...rowLines(row, PLAIN_STYLES),
    ...(row.list === undefined ? [] : ['', ...listLines(row.list)]),
  ]);
}

/** The names `--show` takes in this summary, in its order. */
export function sectionKeys(summary: Summary): string[] {
  return summary.sections.flat().flatMap((row) => (row.key === undefined ? [] : [row.key]));
}

/** A list's sentence, wrapped, then its items, each whole on its own line. */
function listLines(list: RowList, indent = 4): string[] {
  const pad = ' '.repeat(indent);
  return [
    ...wrap(list.intro, WIDTH - indent).map((line) => `${pad}${line}`),
    ...list.items.map((item) => `${pad}  ${item}`),
  ];
}

const PLAIN_STYLES: Styles = {
  accent: (text) => text,
  bold: (text) => text,
  dim: (text) => text,
  red: (text) => text,
};

function rowLines(row: Row, styles: Styles): string[] {
  const label = `${' '.repeat(LABEL_INDENT)}${styles.accent(row.label)}${' '.repeat(VALUE_COLUMN - LABEL_INDENT - columns(row.label))}`;
  const mark = row.bold === true ? styles.bold : (text: string) => text;
  const value = row.value.join('');
  const [first = '', ...rest] = row.whole === true ? [value] : wrap(value, WIDTH - VALUE_COLUMN);
  const lines = [
    `${label}${mark(first)}`,
    ...rest.map((line) => `${' '.repeat(VALUE_COLUMN)}${mark(line)}`),
  ];

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
