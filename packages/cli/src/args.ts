/**
 * The command line, parsed into what each command needs. Unknown flags are an error, so a
 * typo is never read as a silently ignored option.
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

export interface AuditOptions extends CommonOptions, ScopeOptions {
  readonly command: 'audit';
  /** `false` for `--no-probe`: no header reads and no encodes. */
  readonly probe: boolean;
  /** How many images to measure by encoding; `null` is every one (`--probe-all`). */
  readonly maxEncodes: number | null;
  readonly includeDiscarded: boolean;
}

export type Parsed =
  | { readonly kind: 'run'; readonly options: AuditOptions }
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

const AUDIT = {
  ...COMMON,
  ...SCOPE,
  'no-probe': { type: 'boolean' },
  'max-encodes': { type: 'string' },
  'probe-all': { type: 'boolean' },
  'include-discarded': { type: 'boolean' },
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
  if (command !== 'audit') {
    return { kind: 'usage-error', command, message: `\`upfly ${command}\` is not available yet` };
  }
  return parseAudit(rest);
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
  if (positionals.length > 1) {
    return {
      kind: 'usage-error',
      command,
      message: `expected one directory, got ${positionals.length}: ${positionals.join(' ')}`,
    };
  }
  const scope = scopeOf(values);
  if (typeof scope === 'string') return { kind: 'usage-error', command, message: scope };
  const maxEncodes = maxEncodesOf(values);
  if (typeof maxEncodes === 'string') return { kind: 'usage-error', command, message: maxEncodes };

  return {
    kind: 'run',
    options: {
      command,
      dir: positionals[0] ?? '.',
      json: values.json === true,
      noColor: values['no-color'] === true,
      probe: values['no-probe'] !== true,
      maxEncodes,
      includeDiscarded: values['include-discarded'] === true,
      ...scope,
    },
  };
}

function parseAuditArgs(args: readonly string[]) {
  return parseArgs({ args: [...args], options: AUDIT, allowPositionals: true, strict: true });
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
