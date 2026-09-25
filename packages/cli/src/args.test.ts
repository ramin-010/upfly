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
        includeUnusedSvg: false,
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
      '--include-unused-svg',
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
        includeUnusedSvg: true,
        publicDirs: ['', 'apps/web/public'],
        exclude: ['legacy/'],
      },
    });
  });

  it('lifts the cap with --probe-all and skips probing with --no-probe', () => {
    expect(parseCommandLine(['audit', '--probe-all'])).toMatchObject({
      options: { maxEncodes: null },
    });
    expect(parseCommandLine(['audit', '--no-probe'])).toMatchObject({ options: { probe: false } });
  });

  it('plans an optimize of the current directory without writing, by default', () => {
    expect(parseCommandLine(['optimize'])).toEqual({
      kind: 'run',
      options: {
        command: 'optimize',
        dir: '.',
        json: false,
        noColor: false,
        apply: false,
        commit: false,
        replace: false,
        format: null,
        allowDirty: false,
        includeDeclined: false,
        includeDiscarded: false,
        includeUnusedSvg: false,
        publicDirs: null,
        exclude: [],
      },
    });
  });

  it('reads every optimize flag', () => {
    expect(
      parseCommandLine([
        'optimize',
        'site',
        '--apply',
        '--commit',
        '--replace',
        '--format',
        'avif',
        '--public',
        'public',
        '--exclude',
        'drafts/',
        '--include-declined',
        '--include-discarded',
        '--include-unused-svg',
        '--json',
        '--no-color',
      ]),
    ).toEqual({
      kind: 'run',
      options: {
        command: 'optimize',
        dir: 'site',
        json: true,
        noColor: true,
        apply: true,
        commit: true,
        replace: true,
        format: 'avif',
        allowDirty: false,
        includeDeclined: true,
        includeDiscarded: true,
        includeUnusedSvg: true,
        publicDirs: ['public'],
        exclude: ['drafts/'],
      },
    });
    expect(parseCommandLine(['optimize', '--apply', '--allow-dirty'])).toMatchObject({
      options: { apply: true, allowDirty: true },
    });
  });

  it('runs an undo, which takes only a directory and the output flags', () => {
    expect(parseCommandLine(['undo', 'site', '--json'])).toEqual({
      kind: 'run',
      options: { command: 'undo', dir: 'site', json: true, noColor: false },
    });
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
    [['optimize', '--commit'], '--commit commits what --apply writes; add --apply'],
    [['optimize', '--allow-dirty'], '--allow-dirty only changes what --apply does; add --apply'],
    [
      ['optimize', '--apply', '--commit', '--allow-dirty'],
      '--commit and --allow-dirty cannot be used together: the commit must hold only what this run wrote, so --commit needs a folder with no uncommitted changes',
    ],
    [['optimize', '--format', 'png'], '--format takes webp or avif, got `png`'],
    [['optimize', '--max-encodes', '5'], 'unknown option `--max-encodes`'],
    [['optimize', 'a', 'b'], 'expected one directory, got 2: a b'],
    [['undo', '--apply'], 'unknown option `--apply`'],
    [['undo', 'a', 'b'], 'expected one directory, got 2: a b'],
  ])('rejects %j as a usage error', (argv, message) => {
    expect(parseCommandLine(argv)).toEqual(
      expect.objectContaining({ kind: 'usage-error', message }),
    );
  });

  it('answers help and version before anything else', () => {
    expect(parseCommandLine([])).toEqual({ kind: 'help', command: null });
    expect(parseCommandLine(['--help'])).toEqual({ kind: 'help', command: null });
    expect(parseCommandLine(['audit', '--help'])).toEqual({ kind: 'help', command: 'audit' });
    expect(parseCommandLine(['optimize', '-h'])).toEqual({ kind: 'help', command: 'optimize' });
    expect(parseCommandLine(['undo', '--help'])).toEqual({ kind: 'help', command: 'undo' });
    expect(parseCommandLine(['--version'])).toEqual({ kind: 'version' });
  });
});
