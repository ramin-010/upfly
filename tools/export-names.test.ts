import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'export-names.mjs');

describe('the names a package entry exports', () => {
  const folders: string[] = [];
  afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  /** A built package: two runtime values, and two names that exist only as types. */
  function built(
    exportsMap: unknown = { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
  ) {
    const folder = mkdtempSync(join(realpathSync.native(tmpdir()), 'upfly-export-names-'));
    folders.push(folder);
    mkdirSync(join(folder, 'dist'));
    writeFileSync(
      join(folder, 'package.json'),
      JSON.stringify({ type: 'module', exports: exportsMap }),
    );
    writeFileSync(join(folder, 'dist/index.js'), 'export const a = 1;\nexport function b() {}\n');
    writeFileSync(
      join(folder, 'dist/index.d.ts'),
      'export declare const a: number;\nexport declare function b(): void;\nexport type T = string;\nexport interface I {\n  x: number;\n}\n',
    );
    return folder;
  }

  function run(...args: string[]) {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }

  it('lists values from the build and types from the declarations, beside the exports map', () => {
    const result = run('--package', built());
    expect(result.status).toBe(0);
    expect(result.output.split('\n').slice(1, 5)).toEqual([
      'type I',
      'type T',
      'value a',
      'value b',
    ]);
    expect(result.output).toContain('exports map: {".":{"types":"./dist/index.d.ts"');
    expect(result.output).toContain('4 names: 2 values, 2 types only');
  });

  it('passes the same list, and names each line added or missing', () => {
    const folder = built();
    const saved = join(folder, 'expected.txt');
    writeFileSync(saved, run('--package', folder).output);
    expect(run('--package', folder, '--expect', saved).status).toBe(0);

    writeFileSync(saved, run('--package', folder).output.replace('type T\n', 'value c\n'));
    const changed = run('--package', folder, '--expect', saved);
    expect(changed.status).toBe(1);
    expect(changed.output).toContain('missing: value c');
    expect(changed.output).toContain('added: type T');
  });

  it('exits 2 for a package with no entry to read', () => {
    const result = run('--package', built({ './sub': './dist/index.js' }));
    expect(result.status).toBe(2);
    expect(result.output).toContain("has no exports['.'] with import and types");
  });
});
