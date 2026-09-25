/**
 * Where the CLI's words go. With `--json`, stdout carries only JSON lines: progress events,
 * then one final object, so a script can read it line by line. Otherwise stdout carries
 * the report and stderr carries errors and, on a terminal, progress.
 */

import type { CommandName } from './args.js';

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
 * `--no-color`, and never when `NO_COLOR` is set to anything but the empty string.
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
  return stream.isTTY === true;
}

/** Wraps text in an ANSI style when colour is on. */
export function paint(on: boolean, style: 'bold' | 'dim' | 'red' | 'yellow', text: string): string {
  if (!on) return text;
  const codes = { bold: [1, 22], dim: [2, 22], red: [31, 39], yellow: [33, 39] } as const;
  const [open, close] = codes[style];
  return `\u001b[${open}m${text}\u001b[${close}m`;
}

/** Writes one JSON line to stdout. */
export function emit(io: Io, event: Record<string, unknown>): void {
  io.stdout.write(`${JSON.stringify(event)}\n`);
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
  const counts = Object.entries(event)
    .filter(([key]) => key !== 'stage')
    .map(([key, value]) => `${value} ${key}`)
    .join(', ');
  return counts === '' ? `${event.stage}...` : `${event.stage}: ${counts}`;
}
