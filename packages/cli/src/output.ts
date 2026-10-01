/**
 * Where the CLI's words go. With `--json`, stdout carries only JSON lines: progress events,
 * then one final object, so a script can read it line by line. Otherwise stdout carries
 * the report and stderr carries errors and, on a terminal, progress.
 */

import type { CommandName } from './args.js';
import type { ExitCode } from './exit-codes.js';

/** The streams and environment a command runs against, so tests can supply their own. */
export interface Io {
  readonly stdout: Output;
  readonly stderr: Output;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface Output {
  write(text: string): unknown;
  readonly isTTY?: boolean;
}

/** One stage of the run finished, with what it counted. */
export interface ProgressEvent {
  readonly stage: string;
  readonly [count: string]: string | number;
}

/**
 * Whether to colour what goes to `stream`: only on a terminal, never under `--json` or
 * `--no-color`, never when `NO_COLOR` is set to anything but the empty string, and never
 * on a terminal that calls itself `dumb`, which shows escape codes as text.
 *
 * @see https://no-color.org
 */
export function colourFor(
  stream: Output,
  env: Io['env'],
  options: { readonly json: boolean; readonly noColor: boolean },
): boolean {
  if (options.json || options.noColor) return false;
  const noColor = env.NO_COLOR;
  if (noColor !== undefined && noColor !== '') return false;
  if (env.TERM === 'dumb') return false;
  return stream.isTTY === true;
}

/** How many colours a terminal shows: 24-bit, the 256 of xterm, or the 16 of every terminal. */
export type ColourDepth = 'truecolor' | '256' | '16';

/**
 * The terminal's colour depth: 24-bit only when it says so through `COLORTERM`, 256 when
 * `TERM` names a 256-colour terminal, and 16 otherwise.
 */
export function colourDepth(env: Io['env']): ColourDepth {
  const said = env.COLORTERM?.toLowerCase();
  if (said === 'truecolor' || said === '24bit') return 'truecolor';
  return (env.TERM ?? '').includes('256') ? '256' : '16';
}

/**
 * The brand's coral, `#E8365F`, at each depth. Of the 256, index 161 (`#D7005F`) is the
 * nearest by CIE76 distance. Of the 16, bright red: in Windows Terminal's default scheme it
 * is `#E74856`, close to the coral, and it stays apart from the plain red of a failure.
 */
const CORAL: Readonly<Record<ColourDepth, string>> = {
  truecolor: '38;2;232;54;95',
  '256': '38;5;161',
  '16': '91',
};

/**
 * The only ways the CLI marks its text. Colour never carries a meaning on its own: each mark
 * sits on words that already say it.
 */
export interface Styles {
  /** The brand's coral in bold, for structure only: the headline's name and the labels. */
  readonly accent: (text: string) => string;
  /** A total, in the terminal's own colour. */
  readonly bold: (text: string) => string;
  /** A secondary line. */
  readonly dim: (text: string) => string;
  /** A failure, and nothing else. */
  readonly red: (text: string) => string;
}

/**
 * The styles for one stream: each returns its text unchanged when colour is off, so the
 * text then holds no escape code at all.
 *
 * @param on whether to colour, from `colourFor`
 * @param env the environment, which says how many colours the terminal shows
 */
export function stylesFor(on: boolean, env: Io['env']): Styles {
  if (!on) {
    const plain = (text: string) => text;
    return { accent: plain, bold: plain, dim: plain, red: plain };
  }
  const mark = (open: string, close: string) => (text: string) =>
    text === '' ? text : `\u001b[${open}m${text}\u001b[${close}m`;
  return {
    accent: mark(`1;${CORAL[colourDepth(env)]}`, '22;39'),
    bold: mark('1', '22'),
    dim: mark('2', '22'),
    red: mark('31', '39'),
  };
}

/** Writes one JSON line to stdout. */
export function emit(io: Io, event: Record<string, unknown>): void {
  io.stdout.write(`${JSON.stringify(event)}\n`);
}

/** The options every command's output depends on. */
export interface Style {
  readonly command: CommandName;
  readonly json: boolean;
  readonly noColor: boolean;
}

/**
 * Says why a command stopped and returns the exit code to end with: an `error` line under
 * `--json`, otherwise `upfly:` and the message on stderr.
 *
 * @param code the exit code
 * @param message what happened and what to do about it, in sentences
 * @param reason a stable name for a refusal, for scripts that branch on it
 * @returns `code`
 */
export function stopWith(
  io: Io,
  style: Style,
  code: ExitCode,
  message: string,
  reason?: string,
): ExitCode {
  if (style.json) {
    emit(io, {
      type: 'error',
      command: style.command,
      exitCode: code,
      ...(reason === undefined ? {} : { reason }),
      message,
    });
  } else {
    const { red } = stylesFor(colourFor(io.stderr, io.env, style), io.env);
    io.stderr.write(`${red('upfly:')} ${message}\n`);
  }
  return code;
}

/**
 * Reports progress: a JSON line under `--json`, one overwritten line on a terminal, and
 * nothing when stderr is a file or a pipe.
 */
export function progressReporter(
  io: Io,
  command: CommandName,
  json: boolean,
): { update(event: ProgressEvent): void; clear(): void } {
  let shown = false;
  return {
    update(event) {
      if (json) {
        emit(io, { type: 'progress', command, ...event });
        return;
      }
      if (io.stderr.isTTY !== true) return;
      io.stderr.write(`\r\u001b[2K${describeProgress(event)}`);
      shown = true;
    },
    clear() {
      if (shown) io.stderr.write('\r\u001b[2K');
      shown = false;
    },
  };
}

function describeProgress(event: ProgressEvent): string {
  if (event.stage === 'measuring') return `measuring images: ${event.done} of ${event.total}`;
  const counts = Object.entries(event)
    .filter(([key]) => key !== 'stage')
    .map(([key, value]) => `${value} ${key}`)
    .join(', ');
  return counts === '' ? `${event.stage}...` : `${event.stage}: ${counts}`;
}
