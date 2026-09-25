/**
 * The command line, parsed into what each command needs. Unknown flags are an error, so a
 * typo is never read as a silently ignored option, and so is a flag that would change
 * nothing in the run it was given to.
 */

import { parseArgs } from 'node:util';
import { normaliseServedDir } from './config.js';

export type CommandName = 'audit' | 'optimize' | 'undo';

export interface CommonOptions {
  /** The project directory, as given; the current directory when none is. */
  readonly dir: string;
  /** One JSON object per line on stdout: progress, then the result. */
  readonly json: boolean;
  /** `--no-color`; the environment is consulted separately. */
  readonly noColor: boolean;
}

export interface ScopeOptions {
  /** Served folders from `--public`, or `null` when none was given. */
  readonly publicDirs: readonly string[] | null;
  /** Patterns from `--exclude`, added to the config's and `.upflyignore`'s. */
  readonly exclude: readonly string[];
}

export interface ReportOptions {
  /** `--include-discarded`: list the path-like strings that named no image. */
  readonly includeDiscarded: boolean;
  /** `--include-unused-svg`: list the unused SVG files the report otherwise only counts. */
  readonly includeUnusedSvg: boolean;
}

export interface AuditOptions extends CommonOptions, ScopeOptions, ReportOptions {
  readonly command: 'audit';
  /** `false` for `--no-probe`: no header reads and no encodes. */
  readonly probe: boolean;
  /** How many images to measure by encoding; `null` is every one (`--probe-all`). */
  readonly maxEncodes: number | null;
}

export interface OptimizeOptions extends CommonOptions, ScopeOptions, ReportOptions {
  readonly command: 'optimize';
  /** `--apply`: write the plan. Without it the run only reports what it would do. */
  readonly apply: boolean;
  /** `--commit`: commit the files the run wrote, and nothing else, as one commit. */
  readonly commit: boolean;
  /** `--replace`: remove each original once every reference to it has moved. */
  readonly replace: boolean;
  /** `--format`, or `null` for the config's format or the default. */
  readonly format: 'webp' | 'avif' | null;
  /** `--allow-dirty`: apply over uncommitted changes, or where git cannot help. */
  readonly allowDirty: boolean;
  /** `--include-declined`: list each image the plan examined and did not convert. */
  readonly includeDeclined: boolean;
}

export interface UndoOptions extends CommonOptions {
  readonly command: 'undo';
}

export type CommandOptions = AuditOptions | OptimizeOptions | UndoOptions;

export type Parsed =
  | { readonly kind: 'run'; readonly options: CommandOptions }
  | { readonly kind: 'help'; readonly command: CommandName | null }
  | { readonly kind: 'version' }
  | {
      readonly kind: 'usage-error';
      readonly message: string;
      readonly command: CommandName | null;
    };

/**
 * The number of images `audit` measures by encoding when nobody says. Encoding runs largest
 * first, so the first hundred hold most of the bytes worth recovering.
 */
export const DEFAULT_MAX_ENCODES = 100;

const COMMANDS: readonly CommandName[] = ['audit', 'optimize', 'undo'];

const COMMON = {
  json: { type: 'boolean' },
  'no-color': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

const SCOPE = {
  public: { type: 'string', multiple: true },
  exclude: { type: 'string', multiple: true },
} as const;

const REPORT = {
  'include-discarded': { type: 'boolean' },
  'include-unused-svg': { type: 'boolean' },
} as const;

const AUDIT = {
  ...COMMON,
  ...SCOPE,
  ...REPORT,
  'no-probe': { type: 'boolean' },
  'max-encodes': { type: 'string' },
  'probe-all': { type: 'boolean' },
} as const;

const OPTIMIZE = {
  ...COMMON,
  ...SCOPE,
  ...REPORT,
  apply: { type: 'boolean' },
  commit: { type: 'boolean' },
  replace: { type: 'boolean' },
  format: { type: 'string' },
  'allow-dirty': { type: 'boolean' },
  'include-declined': { type: 'boolean' },
} as const;

/**
 * Parses `argv`, the arguments after `upfly`.
 *
 * @param argv the process arguments without the node binary and the script path
 */
export function parseCommandLine(argv: readonly string[]): Parsed {
  const [first, ...rest] = argv;
  if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
    return { kind: 'help', command: null };
  }
  if (first === '--version' || first === '-v') return { kind: 'version' };
  if (!(COMMANDS as readonly string[]).includes(first)) {
    return {
      kind: 'usage-error',
      command: null,
      message: first.startsWith('-')
        ? `${first} needs a command before it, such as \`upfly audit ${first}\``
        : `unknown command \`${first}\``,
    };
  }
  const command = first as CommandName;
  if (command === 'audit') return parseAudit(rest);
  if (command === 'optimize') return parseOptimize(rest);
  return parseUndo(rest);
}

function parseAudit(args: readonly string[]): Parsed {
  const command = 'audit';
  let parsed: ReturnType<typeof parseAuditArgs>;
  try {
    parsed = parseAuditArgs(args);
  } catch (error) {
    return { kind: 'usage-error', command, message: plainParseError(error) };
  }
  const { values, positionals } = parsed;
  if (values.help === true) return { kind: 'help', command };
  const dir = directoryOf(positionals);
  if (dir.problem !== null) return { kind: 'usage-error', command, message: dir.problem };
  const scope = scopeOf(values);
  if (typeof scope === 'string') return { kind: 'usage-error', command, message: scope };
  const maxEncodes = maxEncodesOf(values);
  if (typeof maxEncodes === 'string') return { kind: 'usage-error', command, message: maxEncodes };

  return {
    kind: 'run',
    options: {
      command,
      dir: dir.value,
      json: values.json === true,
      noColor: values['no-color'] === true,
      probe: values['no-probe'] !== true,
      maxEncodes,
      includeDiscarded: values['include-discarded'] === true,
      includeUnusedSvg: values['include-unused-svg'] === true,
      ...scope,
    },
  };
}

function parseAuditArgs(args: readonly string[]) {
  return parseArgs({ args: [...args], options: AUDIT, allowPositionals: true, strict: true });
}

function parseOptimize(args: readonly string[]): Parsed {
  const command = 'optimize';
  let parsed: ReturnType<typeof parseOptimizeArgs>;
  try {
    parsed = parseOptimizeArgs(args);
  } catch (error) {
    return { kind: 'usage-error', command, message: plainParseError(error) };
  }
  const { values, positionals } = parsed;
  if (values.help === true) return { kind: 'help', command };
  const dir = directoryOf(positionals);
  if (dir.problem !== null) return { kind: 'usage-error', command, message: dir.problem };
  const scope = scopeOf(values);
  if (typeof scope === 'string') return { kind: 'usage-error', command, message: scope };
  const format = values.format;
  if (format !== undefined && format !== 'webp' && format !== 'avif') {
    return {
      kind: 'usage-error',
      command,
      message: `--format takes webp or avif, got \`${format}\``,
    };
  }
  const apply = values.apply === true;
  const commit = values.commit === true;
  const allowDirty = values['allow-dirty'] === true;
  const conflict = writeFlagConflict(apply, commit, allowDirty);
  if (conflict !== null) return { kind: 'usage-error', command, message: conflict };

  return {
    kind: 'run',
    options: {
      command,
      dir: dir.value,
      json: values.json === true,
      noColor: values['no-color'] === true,
      apply,
      commit,
      replace: values.replace === true,
      format: format ?? null,
      allowDirty,
      includeDeclined: values['include-declined'] === true,
      includeDiscarded: values['include-discarded'] === true,
      includeUnusedSvg: values['include-unused-svg'] === true,
      ...scope,
    },
  };
}

function parseOptimizeArgs(args: readonly string[]) {
  return parseArgs({ args: [...args], options: OPTIMIZE, allowPositionals: true, strict: true });
}

/**
 * `--commit` and `--allow-dirty` only mean something to a run that writes, and together
 * they would let a commit sweep up changes that were not the run's.
 */
function writeFlagConflict(apply: boolean, commit: boolean, allowDirty: boolean): string | null {
  if (commit && allowDirty) {
    return '--commit and --allow-dirty cannot be used together: the commit must hold only what this run wrote, so --commit needs a folder with no uncommitted changes';
  }
  if (commit && !apply) return '--commit commits what --apply writes; add --apply';
  if (allowDirty && !apply) return '--allow-dirty only changes what --apply does; add --apply';
  return null;
}

function parseUndo(args: readonly string[]): Parsed {
  const command = 'undo';
  let parsed: ReturnType<typeof parseUndoArgs>;
  try {
    parsed = parseUndoArgs(args);
  } catch (error) {
    return { kind: 'usage-error', command, message: plainParseError(error) };
  }
  const { values, positionals } = parsed;
  if (values.help === true) return { kind: 'help', command };
  const dir = directoryOf(positionals);
  if (dir.problem !== null) return { kind: 'usage-error', command, message: dir.problem };
  return {
    kind: 'run',
    options: {
      command,
      dir: dir.value,
      json: values.json === true,
      noColor: values['no-color'] === true,
    },
  };
}

function parseUndoArgs(args: readonly string[]) {
  return parseArgs({ args: [...args], options: COMMON, allowPositionals: true, strict: true });
}

function directoryOf(
  positionals: readonly string[],
): { readonly value: string; readonly problem: null } | { readonly problem: string } {
  if (positionals.length > 1) {
    return {
      problem: `expected one directory, got ${positionals.length}: ${positionals.join(' ')}`,
    };
  }
  return { value: positionals[0] ?? '.', problem: null };
}

/** How many images to encode, from the three flags that decide it, or a usage error. */
function maxEncodesOf(values: {
  readonly 'no-probe'?: boolean | undefined;
  readonly 'max-encodes'?: string | undefined;
  readonly 'probe-all'?: boolean | undefined;
}): number | null | string {
  const given = [
    values['no-probe'] === true && '--no-probe',
    values['max-encodes'] !== undefined && '--max-encodes',
    values['probe-all'] === true && '--probe-all',
  ].filter((flag): flag is string => typeof flag === 'string');
  if (given.length > 1) {
    return `${given.slice(0, -1).join(', ')} and ${given.at(-1)} cannot be used together`;
  }
  if (values['probe-all'] === true) return null;
  const written = values['max-encodes'];
  if (written === undefined) return DEFAULT_MAX_ENCODES;
  const n = Number(written);
  return Number.isInteger(n) && n >= 0
    ? n
    : `--max-encodes takes a whole number of images, got \`${written}\``;
}

function scopeOf(values: {
  readonly public?: readonly string[] | undefined;
  readonly exclude?: readonly string[] | undefined;
}): ScopeOptions | string {
  let publicDirs: string[] | null = null;
  if (values.public !== undefined) {
    publicDirs = [];
    for (const dir of values.public) {
      const normalised = normaliseServedDir(dir);
      if (normalised === null) {
        return `--public takes a folder inside the project, such as \`public\`, or \`.\` for the project root; got \`${dir}\``;
      }
      publicDirs.push(normalised);
    }
  }
  return { publicDirs, exclude: [...(values.exclude ?? [])] };
}

/** Node's own wording names the option in its own style; this keeps it short and plain. */
function plainParseError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const unknown = /Unknown option '([^']+)'/.exec(message);
  if (unknown) return `unknown option \`${unknown[1]}\``;
  const missing = /Option '([^']+?)(?: <value>)?' argument missing/.exec(message);
  if (missing) return `\`${missing[1]?.replace(/^-[a-z], /, '')}\` needs a value`;
  const ambiguous = /Option '([^']+)' argument is ambiguous/.exec(message);
  if (ambiguous) {
    return `\`${ambiguous[1]}\` needs a value; one that starts with a dash is written \`${ambiguous[1]}=<value>\``;
  }
  return message.split('\n')[0] ?? message;
}
