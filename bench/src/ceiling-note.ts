/**
 * What the speed gate adds when it measures over its ceiling on a machine outside CI.
 *
 * The ceiling is set for CI's runners. A slower machine can measure unchanged HEAD over it,
 * and the gate then fails before and after any change, so it judges none of them.
 */

import { spawnSync } from 'node:child_process';

/** What the note depends on. */
export interface CeilingNoteInput {
  /** Whether the headline was over the ceiling. */
  readonly over: boolean;
  /** Whether this run is CI's, whose runners the ceiling was measured on. */
  readonly inCi: boolean;
  /** Whether the measured tree is HEAD with no tracked file changed, or undefined if unknown. */
  readonly headUnchanged: boolean | undefined;
}

/**
 * The lines to print under the gate's verdict, or an empty string when there is nothing to add.
 *
 * @example
 * ceilingNote({ over: true, inCi: false, headUnchanged: true });
 * // a blank line, then four indented lines: "This gate cannot judge a change on this
 * // machine: ...", and how to judge one instead
 * ceilingNote({ over: true, inCi: true, headUnchanged: true }); // ''
 */
export function ceilingNote({ over, inCi, headUnchanged }: CeilingNoteInput): string {
  if (!over || inCi) return '';
  const why =
    headUnchanged === true
      ? [
          '  This gate cannot judge a change on this machine: HEAD, unchanged, is over the ceiling,',
          "  which is set for CI's runners.",
        ]
      : [
          '  If HEAD, unchanged, is over the ceiling on this machine too, this gate cannot judge a',
          "  change here: the ceiling is set for CI's runners. Run the gate on a clean tree to see.",
        ];
  return [
    '',
    ...why,
    '  Judge a change instead by an A/B run back to back in one session, old against new, set',
    '  against the noise floor bench/src/noise.ts measures.',
    '',
  ].join('\n');
}

/**
 * Whether the repository at `root` has no tracked file changed from HEAD, or undefined when git
 * cannot say. Untracked files are left out: the build compiles only what the sources import.
 */
export function headUnchangedAt(root: string): boolean | undefined {
  const status = spawnSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'], {
    encoding: 'utf8',
  });
  return status.status === 0 ? status.stdout.trim() === '' : undefined;
}
