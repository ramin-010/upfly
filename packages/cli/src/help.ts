/** What `upfly --help` and `upfly <command> --help` print. */

import type { CommandName } from './args.js';

const GENERAL = `Usage: upfly <command> [dir] [options]

Finds every image in a project and every place it is referenced.

Commands:
  audit [dir]    Report images, references, and what could be smaller. Changes nothing.

Options for every command:
  --json         Print one JSON object per line: progress, then the result
  --no-color     Plain text; also when NO_COLOR is set
  -h, --help     Show help for a command
  -v, --version  Print the version

dir is the project to read, the current directory by default. Its upfly.config.ts or
upfly.config.json is read if there is one.
`;

const AUDIT = `Usage: upfly audit [dir] [options]

Reports every image in the project, every reference to it, the references that point at
nothing, the images nothing references, and how much smaller each image would be as WebP.
It reads the project and changes nothing.

Options:
  --public <dir>         A folder the site is served from, such as public; repeat it for
                         several, and use . for the project root itself. Without it, Upfly
                         works the folders out and says so
  --exclude <pattern>    Leave matching paths out, in .gitignore syntax; repeatable
  --max-encodes <n>      Measure the n largest images by encoding them (default 100)
  --probe-all            Measure every image, however many
  --no-probe             Read no image at all; sizes and savings are then not measured
  --include-discarded    Also list the path-like strings that named no image
  --json                 Print one JSON object per line: progress, then the report
  --no-color             Plain text; also when NO_COLOR is set

Exit status: 0 when the audit ran, 2 for a usage or configuration error, 3 when the
configuration file belongs to another tool.
`;

/** The help for one command, or the general help when `command` is null. */
export function helpText(command: CommandName | null): string {
  return command === 'audit' ? AUDIT : GENERAL;
}
