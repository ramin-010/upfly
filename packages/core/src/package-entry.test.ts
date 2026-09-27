import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as source from './index.js';

const run = promisify(execFile);

/** The package's own folder, where `package.json` and the built `dist/` live. */
const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..');

interface Manifest {
  readonly name: string;
  readonly files: readonly string[];
  readonly exports: Record<string, { readonly types: string; readonly import: string }>;
}

const manifest = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8')) as Manifest;

/**
 * A project outside the repository with the package in its `node_modules`, as an install
 * leaves it. A junction on Windows, which needs no special rights; a symlink elsewhere.
 */
let project = '';
beforeAll(async () => {
  project = await mkdtemp(join(tmpdir(), 'upfly-package-entry-'));
  await mkdir(join(project, 'node_modules'));
  await symlink(PACKAGE, join(project, 'node_modules', manifest.name), 'junction');
});
afterAll(async () => {
  await rm(project, { recursive: true, force: true });
});

/** Runs a module script in the outside project and returns what it prints. */
async function inProject(script: string): Promise<string> {
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], {
    cwd: project,
  });
  return stdout.trim();
}

describe('the package entry, imported the way a user imports it', () => {
  it('gives an import from outside the repository everything the source index exports', async () => {
    const names = await inProject(
      `const m = await import('${manifest.name}'); console.log(JSON.stringify(Object.keys(m).sort()));`,
    );

    expect(JSON.parse(names)).toEqual(Object.keys(source).sort());
  }, 30_000);

  it('refuses a path inside the package that the map does not name', async () => {
    const outcome = await inProject(
      `try { await import('${manifest.name}/dist/index.js'); console.log('imported'); } catch (e) { console.log(e.code); }`,
    );

    expect(outcome).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED');
  }, 30_000);

  it('names only files that exist and that the package publishes', () => {
    for (const entry of Object.values(manifest.exports)) {
      // The declarations a TypeScript user gets are the ones beside the module they import.
      expect(entry.types).toBe(`${entry.import.slice(0, -'.js'.length)}.d.ts`);
      for (const target of [entry.types, entry.import]) {
        expect(existsSync(join(PACKAGE, target))).toBe(true);
        const published = manifest.files.some((folder) =>
          target.replace(/^\.\//, '').startsWith(folder),
        );
        expect(published).toBe(true);
      }
    }
  });
});
