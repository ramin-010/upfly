/** What `upfly --help` and `upfly <command> --help` print. */

import type { CommandName } from './args.js';

const GENERAL = `Usage: upfly <command> [dir] [options]

Finds every image in a project and every place it is referenced.

Commands:
  audit [dir]      Report images, references, and what could be smaller. Changes nothing.
  optimize [dir]   Convert images and update every reference to them. Shows the plan and
                   changes nothing unless run with --apply.
  undo [dir]       Put back every file the last optimize --apply changed.

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
  --include-unused-svg   Also list the unused SVG files, which are otherwise only counted
  --json                 Print one JSON object per line: progress, then the report
  --no-color             Plain text; also when NO_COLOR is set

Exit status: 0 when the audit ran, 2 for a usage or configuration error, 3 when the
configuration file belongs to another tool, 4 for a failure Upfly did not anticipate.
`;

const OPTIMIZE = `Usage: upfly optimize [dir] [options]

Converts each image that measures smaller as WebP (or AVIF) and updates every reference
to it that Upfly can rewrite safely. Without --apply it writes nothing and shows the plan:
what would be converted, which files would change, and why anything is left alone.

Options:
  --apply                Write the plan. Refused while the project folder has uncommitted
                         changes or git does not track it, so that the run's changes are
                         the only ones to review
  --commit               With --apply: commit exactly the files the run wrote, as one
                         commit that git revert undoes
  --replace              Remove each original once every reference to it has moved to the
                         converted file. Without it, originals are kept beside it
  --format <webp|avif>   The format to convert to (default webp)
  --public <dir>         A folder the site is served from, such as public; repeat it for
                         several, and use . for the project root itself
  --exclude <pattern>    Leave matching paths out, in .gitignore syntax; repeatable
  --allow-dirty          With --apply: write even with uncommitted changes, or outside a
                         git repository. upfly undo still puts the files back
  --include-declined     Also list each image left unconverted, with the reason
  --include-discarded    Also list the path-like strings that named no image
  --include-unused-svg   Also list the unused SVG files, which are otherwise only counted
  --json                 Print one JSON object per line: progress, then the result
  --no-color             Plain text; also when NO_COLOR is set

Every image is measured before it is converted, so the first run on a large project
takes a while. The record of an applied run is kept in .upfly/, which git is told to
ignore.

Exit status: 0 when the run finished, including when there was nothing to do; 2 for a
usage or configuration error; 3 when Upfly refused to write, and the message says why and
what to do; 4 for a failure Upfly did not anticipate.
`;

const UNDO = `Usage: upfly undo [dir] [options]

Puts back every file the last optimize --apply changed: removed originals come back,
updated references point at them again, and converted files are removed. It checks each
file first and changes nothing if any of them was edited since that run.

Options:
  --json                 Print one JSON object per line: the result
  --no-color             Plain text; also when NO_COLOR is set

Exit status: 0 when the files were put back or there was nothing to undo; 2 for a usage
error; 3 when undo refused because a file changed since the run, or another run is in
progress; 4 for a failure Upfly did not anticipate.
`;

const TEXT: Record<CommandName, string> = { audit: AUDIT, optimize: OPTIMIZE, undo: UNDO };

/** The help for one command, or the general help when `command` is null. */
export function helpText(command: CommandName | null): string {
  return command === null ? GENERAL : TEXT[command];
}
