/** Reads the command line, runs the command, and returns the exit code. */

import { type CommandOptions, parseCommandLine } from './args.js';
import { runAudit } from './audit.js';
import { EXIT_CODES, type ExitCode, VERSION } from './exit-codes.js';
import { helpText } from './help.js';
import { runOptimize } from './optimize.js';
import { type Io, colourFor, emit, paint } from './output.js';
import { runUndo } from './undo.js';

/**
 * Runs one invocation of the CLI.
 *
 * @param argv the arguments after `upfly`
 * @param io the streams and environment to use
 * @returns the process exit code
 */
export async function main(argv: readonly string[], io: Io): Promise<ExitCode> {
  const parsed = parseCommandLine(argv);
  const json = argv.includes('--json');

  if (parsed.kind === 'version') {
    io.stdout.write(`${VERSION}\n`);
    return EXIT_CODES.OK;
  }
  if (parsed.kind === 'help') {
    io.stdout.write(helpText(parsed.command));
    return EXIT_CODES.OK;
  }
  if (parsed.kind === 'usage-error') {
    if (json) {
      emit(io, {
        type: 'error',
        command: parsed.command,
        exitCode: EXIT_CODES.USAGE,
        message: parsed.message,
      });
    } else {
      const colour = colourFor(io.stderr, io.env, { json, noColor: argv.includes('--no-color') });
      const help = parsed.command === null ? 'upfly --help' : `upfly ${parsed.command} --help`;
      io.stderr.write(`${paint(colour, 'red', 'upfly:')} ${parsed.message}\nSee \`${help}\`.\n`);
    }
    return EXIT_CODES.USAGE;
  }
  try {
    return await run(parsed.options, io);
  } catch (error) {
    // Neither a finding nor a refusal: something Upfly did not anticipate went wrong.
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      emit(io, {
        type: 'error',
        command: parsed.options.command,
        exitCode: EXIT_CODES.INTERNAL,
        message,
      });
    } else {
      io.stderr.write(`upfly: failed unexpectedly: ${message}\n`);
    }
    return EXIT_CODES.INTERNAL;
  }
}

function run(options: CommandOptions, io: Io): Promise<ExitCode> {
  switch (options.command) {
    case 'audit':
      return runAudit(options, io);
    case 'optimize':
      return runOptimize(options, io);
    case 'undo':
      return runUndo(options, io);
  }
}
