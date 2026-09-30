/**
 * What the `upfly` package's entry gives a library user, and that each name is documented.
 * A change to either is a change a user sees, so the list is written down here.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as entry from './index.js';

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..');

describe("the upfly package's entry", () => {
  it('exports as values only the config helper and the exit codes', () => {
    expect(Object.keys(entry).sort()).toEqual(['EXIT_CODES', 'defineConfig']);
  });

  it('documents every name it exports, as its declaration', () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8'));
    const types = join(PACKAGE, manifest.exports['.'].types);
    const program = ts.createProgram([types], {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
    });
    const checker = program.getTypeChecker();
    const file = program.getSourceFile(types);
    const module = file === undefined ? undefined : checker.getSymbolAtLocation(file);
    const names = module === undefined ? [] : checker.getExportsOfModule(module);
    const undocumented = names
      .filter((symbol) => {
        const target =
          symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
        return ts.displayPartsToString(target.getDocumentationComment(checker)).trim() === '';
      })
      .map((symbol) => symbol.getName());

    expect(names.map((symbol) => symbol.getName()).sort()).toEqual([
      'EXIT_CODES',
      'ExitCode',
      'UpflyConfig',
      'defineConfig',
    ]);
    expect(undocumented).toEqual([]);
  });
});
