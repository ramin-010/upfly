import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_ENCODES, parseCommandLine } from './args.js';

describe('parseCommandLine', () => {
  it('runs an audit of the current directory with the measured defaults', () => {
    expect(parseCommandLine(['audit'])).toEqual({
      kind: 'run',
      options: {
        command: 'audit',
        dir: '.',
        json: false,
        noColor: false,
        probe: true,
        maxEncodes: DEFAULT_MAX_ENCODES,
        includeDiscarded: false,
        publicDirs: null,
        exclude: [],
      },
    });
  });

  it('reads every audit flag', () => {
    const parsed = parseCommandLine([
      'audit',
      'site',
      '--json',
      '--no-color',
      '--max-encodes',
      '12',
      '--include-discarded',
      '--public',
      '.',
      '--public',
      'apps/web/public/',
      '--exclude',
      'legacy/',
    ]);
    expect(parsed).toEqual({
      kind: 'run',
      options: {
        command: 'audit',
        dir: 'site',
        json: true,
        noColor: true,
        probe: true,
        maxEncodes: 12,
        includeDiscarded: true,
        publicDirs: ['', 'apps/web/public'],
        exclude: ['legacy/'],
      },
    });
  });

  it('lifts the cap with --probe-all and skips probing with --no-probe', () => {
    const all = parseCommandLine(['audit', '--probe-all']);
    const none = parseCommandLine(['audit', '--no-probe']);
    expect(all.kind === 'run' && all.options.maxEncodes).toBeNull();
    expect(none.kind === 'run' && none.options.probe).toBe(false);
  });

  it.each([
    [['audit', '--probe-all', '--no-probe'], '--no-probe and --probe-all cannot be used together'],
    [
      ['audit', '--probe-all', '--no-probe', '--max-encodes', '5'],
      '--no-probe, --max-encodes and --probe-all cannot be used together',
    ],
    [['audit', '--max-encodes', 'ten'], '--max-encodes takes a whole number of images, got `ten`'],
    [['audit', '--max-encodes=-1'], '--max-encodes takes a whole number of images, got `-1`'],
    [
      ['audit', '--max-encodes', '-1'],
      '`--max-encodes` needs a value; one that starts with a dash is written `--max-encodes=<value>`',
    ],
    [['audit', '--nope'], 'unknown option `--nope`'],
    [['audit', 'a', 'b'], 'expected one directory, got 2: a b'],
    [
      ['audit', '--public', '../site'],
      '--public takes a folder inside the project, such as `public`, or `.` for the project root; got `../site`',
    ],
    [['audity'], 'unknown command `audity`'],
    [['--json'], '--json needs a command before it, such as `upfly audit --json`'],
  ])('rejects %j as a usage error', (argv, message) => {
    expect(parseCommandLine(argv)).toEqual(
      expect.objectContaining({ kind: 'usage-error', message }),
    );
  });

  it('answers help and version before anything else', () => {
    expect(parseCommandLine([])).toEqual({ kind: 'help', command: null });
    expect(parseCommandLine(['--help'])).toEqual({ kind: 'help', command: null });
    expect(parseCommandLine(['audit', '--help'])).toEqual({ kind: 'help', command: 'audit' });
    expect(parseCommandLine(['--version'])).toEqual({ kind: 'version' });
  });
});
