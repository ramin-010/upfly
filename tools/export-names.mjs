#!/usr/bin/env node
// @ts-check
/**
 * Lists the names a package's entry exports, so a change meant to move no public name can
 * prove it moved none: runtime values from the built `import` entry, and every declared name
 * from its `types` entry through TypeScript's checker, beside the package's `exports` map.
 *
 * Usage: `node tools/export-names.mjs [--package <dir>] [--expect <file>]`, after
 * `pnpm build` (it reads the build). With `--expect`, the list is compared with a saved one,
 * and each name added or missing is printed.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The exports map, then one line per name, `value <name>` or `type <name>`, in code-point
 * order so the list is the same on every machine.
 *
 * @param {string} packageDir
 * @returns {Promise<string[] | string>} the lines, or why they cannot be listed
 */
export async function exportNames(packageDir) {
  const manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  const entry = manifest.exports?.['.'];
  if (typeof entry?.import !== 'string' || typeof entry?.types !== 'string') {
    return `${path.join(packageDir, 'package.json')} has no exports['.'] with import and types`;
  }
  const built = await import(pathToFileURL(path.resolve(packageDir, entry.import)).href);
  const runtime = new Set(Object.keys(built));
  const ts = createRequire(path.join(ROOT, 'package.json'))('typescript');
  const types = path.resolve(packageDir, entry.types);
  const program = ts.createProgram([types], {
    noEmit: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(types);
  const symbol = source === undefined ? undefined : checker.getSymbolAtLocation(source);
  /** @type {string[]} */
  const declared =
    symbol === undefined
      ? []
      : checker.getExportsOfModule(symbol).map((/** @type {any} */ s) => s.getName());
  const names = [...new Set([...declared, ...runtime])].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return [
    `exports map: ${JSON.stringify(manifest.exports)}`,
    ...names.map((name) => `${runtime.has(name) ? 'value' : 'type'} ${name}`),
  ];
}

/**
 * @param {{ packageDir: string, expect: string | null }} options
 * @returns {Promise<{ exitCode: number, output: string }>}
 */
export async function run({ packageDir, expect }) {
  const lines = await exportNames(packageDir);
  if (typeof lines === 'string') return { exitCode: 2, output: `export-names: ${lines}\n` };
  const values = lines.filter((line) => line.startsWith('value ')).length;
  const summary = `${lines.length - 1} names: ${values} values, ${lines.length - 1 - values} types only`;
  if (expect === null) return { exitCode: 0, output: `${[...lines, summary].join('\n')}\n` };

  const listed = (/** @type {string} */ line) =>
    line.startsWith('value ') || line.startsWith('type ') || line.startsWith('exports map: ');
  const expected = readFileSync(expect, 'utf8').split(/\r?\n/).filter(listed);
  const now = new Set(lines);
  const before = new Set(expected);
  const differences = [
    ...expected.filter((line) => !now.has(line)).map((line) => `  missing: ${line}`),
    ...lines.filter((line) => !before.has(line)).map((line) => `  added: ${line}`),
  ];
  const verdict =
    differences.length === 0
      ? 'The same names as expected.'
      : `${differences.length} lines differ from the expected list.`;
  return {
    exitCode: differences.length === 0 ? 0 : 1,
    output: `${[summary, ...differences, verdict].join('\n')}\n`,
  };
}

/**
 * @param {readonly string[]} argv
 * @returns {{ packageDir: string, expect: string | null } | string}
 */
export function parseArgs(argv) {
  let packageDir = path.join(ROOT, 'packages', 'core');
  /** @type {string | null} */
  let expect = null;
  for (let i = 0; i < argv.length; i += 2) {
    const [arg, value] = [argv[i], argv[i + 1]];
    if (value === undefined) return `${arg} needs a value`;
    if (arg === '--package') packageDir = path.resolve(value);
    else if (arg === '--expect') expect = path.resolve(value);
    else return `unknown argument: ${arg}`;
  }
  return { packageDir, expect };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  if (typeof options === 'string') {
    process.stderr.write(`export-names: ${options}\n`);
    process.exit(2);
  }
  const result = await run(options);
  (result.exitCode === 0 ? process.stdout : process.stderr).write(result.output);
  process.exit(result.exitCode);
}
