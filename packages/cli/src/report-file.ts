/**
 * The full text of a run, kept in Upfly's own folder so that the terminal can show a summary.
 * The folder's `.gitignore` is written before anything else in it, so a report never shows as
 * a change in git and never stops a later `optimize --apply` as one.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UPFLY_DIRECTORY } from 'upfly-core/internal';
import type { Io } from './output.js';

/** Where the last run's full text is kept, relative to the project. */
export const REPORT_PATH = `${UPFLY_DIRECTORY}/report.txt`;

/** The report file as written, or why it could not be. */
export type ReportFile = { readonly written: string } | { readonly failed: string };

/**
 * Writes `text` to `.upfly/report.txt`, replacing the last run's, and for an applied run a
 * copy into that run's own folder, which stays until a later applied run replaces it.
 *
 * @param root the project directory
 * @param text the full text, as `--full` prints it
 * @param runDir the applied run's folder relative to the project, such as
 *   `.upfly/runs/<id>`, or null for a run that wrote nothing
 * @returns the path written, or the reason it could not be: a read-only folder must not stop
 *   a command whose real work is done
 */
export function writeReport(root: string, text: string, runDir: string | null): ReportFile {
  try {
    mkdirSync(join(root, UPFLY_DIRECTORY), { recursive: true });
    writeIgnoreFile(root);
    writeFileSync(join(root, REPORT_PATH), text);
    if (runDir !== null) {
      mkdirSync(join(root, runDir), { recursive: true });
      writeFileSync(join(root, runDir, 'report.txt'), text);
    }
    return { written: REPORT_PATH };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { failed: code ?? (error instanceof Error ? error.message : String(error)) };
  }
}

/**
 * Says so on stderr when `--full` printed the text but it could not be kept as well, since
 * the file would then still hold an earlier run's text.
 */
export function warnIfNotKept(io: Pick<Io, 'stderr'>, file: ReportFile): void {
  if ('failed' in file) {
    io.stderr.write(`The full text could not be kept in ${REPORT_PATH} (${file.failed}).\n`);
  }
}

/** The same file an applied run writes, and like it, left alone when it is already there. */
function writeIgnoreFile(root: string): void {
  try {
    writeFileSync(join(root, UPFLY_DIRECTORY, '.gitignore'), '*\n', { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}
