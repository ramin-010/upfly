import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { compareSources } from './token-diff.mjs';

const SCRIPT = fileURLToPath(new URL('./token-diff.mjs', import.meta.url));
const SOURCE = 'packages/demo/src/demo.ts';
const TEST = 'packages/demo/src/demo.test.ts';
const SHAPES = 'packages/core/src/shapes.ts';
const BENCH = 'bench/src/report.ts';

function kinds(before: string, after: string, file = SOURCE) {
  return compareSources(before, after, file).map((difference) => difference.kind);
}

describe('a change to comments and whitespace is no difference', () => {
  it('rewords, removes and adds comments of every form', () => {
    const before = [
      '#!/usr/bin/env node',
      '/**',
      ' * 🔴 **Parses the thing** — R184 says so.',
      ' */',
      'export function parse(text: string) {',
      '  // ⚠️ a long note that goes on',
      '  // and on',
      '  return text.trim(); /* trailing */',
      '}',
      '// at the end of the file',
    ].join('\n');
    const after = [
      '#!/usr/bin/env node',
      '/** Parses the thing. */',
      'export function parse(text: string) {',
      '  return text.trim();',
      '}',
      '',
    ].join('\n');
    expect(compareSources(before, after, SOURCE)).toEqual([]);
  });

  it('rewrites the tags of a TypeScript JSDoc block, which the compiler does not read', () => {
    const before = [
      '/**',
      ' * Parses it.',
      ' * @param text — the whole file (R12)',
      ' * @returns the parsed tree',
      ' * @example parse("a")',
      ' */',
      'export function parse(text: string) {}',
    ].join('\n');
    const after = '/** Parses it. @param text the file */\nexport function parse(text: string) {}';
    expect(kinds(before, after)).toEqual([]);
  });

  it("rewords the prose of a JavaScript file's JSDoc, keeping its types", () => {
    const before =
      '/**\n * Old words.\n * @param {string} text — R12\n */\nexport function f(text) {}';
    const after = '/** New words. @param {string} text the file */\nexport function f(text) {}';
    expect(kinds(before, after, 'tools/demo.mjs')).toEqual([]);
  });

  it('reflows code across lines', () => {
    expect(kinds('const a = f(1, 2);', 'const a = f(\n  1,\n  2\n);')).toEqual([]);
  });

  it('drops the trailing comma the formatter removes when a list collapses', () => {
    const before = ['const list = [', "  'a', // why a", "  'b',", '];'].join('\n');
    expect(kinds(before, "const list = ['a', 'b'];")).toEqual([]);
    expect(kinds('call(\n  a, // note\n  b,\n);', 'call(a, b);')).toEqual([]);
    expect(kinds('const { a, } = o;', 'const { a } = o;')).toEqual([]);
  });

  it('drops the leading bar the formatter removes when a union collapses', () => {
    const before = "type Kind =\n  // the first\n  | 'a'\n  // the second\n  | 'b';";
    expect(kinds(before, "type Kind = 'a' | 'b';")).toEqual([]);
    expect(kinds("type One = | 'a';", "type One = 'a';")).toEqual([]);
    expect(kinds('type Both =\n  // note\n  & A\n  & B;', 'type Both = A & B;')).toEqual([]);
  });

  it('drops the parentheses the formatter removes around a whole return or throw value', () => {
    const before = 'function f() {\n  return (\n    // why\n    a && b\n  );\n}';
    expect(kinds(before, 'function f() {\n  return a && b;\n}')).toEqual([]);
    expect(kinds('throw (\n  // why\n  new Error()\n);', 'throw new Error();')).toEqual([]);
  });

  it('normalises line endings, as a template literal does', () => {
    const lf = 'const text = `one\ntwo`;\n// note\n';
    expect(kinds(lf.replace(/\n/g, '\r\n'), lf)).toEqual([]);
  });

  it('keeps a tool directive but lets the prose after it change', () => {
    const before = '// biome-ignore lint/style/noParameterAssign: R12 — the old reason\nx = 1;';
    const after = '// biome-ignore lint/style/noParameterAssign: the reason\nx = 1;';
    expect(kinds(before, after)).toEqual([]);
  });

  it('a directive named inside prose is not a directive', () => {
    const before = '// a `@ts-expect-error` here did not survive the formatter\nconst a = 1;';
    expect(kinds(before, 'const a = 1;')).toEqual([]);
  });
});

describe('a change of behaviour is reported', () => {
  it('a changed literal, with the line on each side', () => {
    const differences = compareSources('// note\nconst a = 1;', 'const a = 2;', SOURCE);
    expect(differences).toEqual([
      {
        kind: 'code',
        before: [expect.objectContaining({ text: '1', line: 2 })],
        after: [expect.objectContaining({ text: '2', line: 1 })],
      },
    ]);
  });

  it.each([
    ['an added statement', 'f();', 'f();\ng();'],
    ['a removed argument', 'f(a, b);', 'f(a);'],
    ['a moved parenthesis', 'const x = (a + b) * c;', 'const x = a + b * c;'],
    ['a parenthesis inside a returned value', 'return (a + b) * c;', 'return a + b * c;'],
    ['a union turned intersection', "type K = 'a' | 'b';", "type K = 'a' & 'b';"],
    ['a bar between members removed', "type K = | 'a' | 'b';", "type K = 'a' 'b';"],
    ['a changed operator', 'if (a === b) f();', 'if (a !== b) f();'],
    ['a changed regular expression', 'const r = /a+/g;', 'const r = /a*/g;'],
    ['a changed template literal', 'const t = `a ${b} c`;', 'const t = `a ${b} d`;'],
    ['a changed type', 'let a: string;', 'let a: number;'],
    ['a changed shebang', '#!/usr/bin/env node\nf();', '#!/usr/bin/env bun\nf();'],
    ['a removed directive', '// @ts-expect-error: wrong on purpose\nf(1);', 'f(1);'],
    ['a removed coverage directive', '/* v8 ignore next */\nf();', 'f();'],
    [
      'a changed biome rule',
      '// biome-ignore lint/a/b: x\nf();',
      '// biome-ignore lint/a/c: x\nf();',
    ],
  ])('%s', (_, before, after) => {
    expect(kinds(before, after)).toContain('code');
  });

  it.each([
    ['a changed parameter type', '/** @param {string} a */', '/** @param {number} a */'],
    ['a changed type cast', '/** @type {const} */', '/** @type {string[]} */'],
    ['a removed typedef', '/** @typedef {{ a: 1 }} Row */', '/** Row. */'],
    ['a renamed template', '/** @template T */', '/** @template U */'],
  ])("%s in a JavaScript file's JSDoc", (_, before, after) => {
    const code = '\nexport const f = (a) => a;';
    expect(kinds(before + code, after + code, 'tools/demo.mjs')).toEqual(['code']);
  });

  it('a string that is not a test title, even in a test file', () => {
    expect(kinds("expect(f()).toBe('R181');", "expect(f()).toBe('fact');", TEST)).toEqual(['code']);
  });

  it('a deleted test', () => {
    const before = "it('one', () => {});\nit('two', () => {});";
    expect(kinds(before, "it('one', () => {});", TEST)).toEqual(['code']);
  });
});

describe('the three allowed kinds', () => {
  it('a renamed test title is kind (a), in every form a title takes', () => {
    const cases = [
      ["it('R181 (b′)', () => {});", "it('keeps the original', () => {});"],
      ["describe('R80', () => {});", "describe('patterns', () => {});"],
      ["test('R1', () => {});", "test('one', () => {});"],
      ["it.skip('R1', () => {});", "it.skip('one', () => {});"],
      ["it.each([[1]])('R1 %s', (n) => {});", "it.each([[1]])('one %s', (n) => {});"],
      ["describe.each([[1]])('R1 %s', () => {});", "describe.each([[1]])('one %s', () => {});"],
      ["it.skipIf(win)('R1', () => {});", "it.skipIf(win)('one', () => {});"],
      ["it('R1 ' + 'part', () => {});", "it('one', () => {});"],
      ['it(`R1 ${name}`, () => {});', 'it(`one ${name}`, () => {});'],
    ];
    for (const [before = '', after = ''] of cases) {
      expect(kinds(before, after, TEST)).toEqual(['test-title']);
    }
  });

  it('prints the old and the new title', () => {
    const [difference] = compareSources("it('R1', () => {});", "it('one', () => {});", TEST);
    expect(difference?.before[0]?.text).toBe("'R1'");
    expect(difference?.after[0]?.text).toBe("'one'");
  });

  it('an each table is test data, not a title', () => {
    const before = "it.each([['R1', 1]])('%s', (_, n) => {});";
    const after = "it.each([['one', 1]])('%s', (_, n) => {});";
    expect(kinds(before, after, TEST)).toEqual(['code']);
  });

  it('a title and a code change side by side are reported apart', () => {
    const before = "it('R1', () => { f(1); });";
    const after = "it('one', () => { f(2); });";
    expect(kinds(before, after, TEST)).toEqual(['test-title', 'code']);
  });

  const table = (why: string, label = 'img@src') =>
    `export const SHAPES = [\n  { id: 'a', label: '${label}', why:\n    ${why} },\n] as const satisfies readonly X[];`;

  it('a SHAPES why is kind (b), however it is concatenated', () => {
    const before = table("'🔴 R90 reversed it: ' +\n    'a raw-text element swallows the rest'");
    const after = table("'An unclosed raw-text element swallows the rest of the document.'");
    expect(kinds(before, after, SHAPES)).toEqual(['shapes-why']);
  });

  it('only the why, only in SHAPES, and only in its own file', () => {
    expect(kinds(table("'R1'", 'a'), table("'R1'", 'b'), SHAPES)).toEqual(['code']);
    expect(kinds(table("'R1'"), table("'one'"), SOURCE)).toEqual(['code']);
    const other = (why: string) => `export const OTHER = [{ why: ${why} }];`;
    expect(kinds(other("'R1'"), other("'one'"), SHAPES)).toEqual(['code']);
  });

  it('a bench string that held a ruling number is kind (c)', () => {
    const before = "console.log(`  unscanned (R86): ${n}`);\nconsole.log('§3.4 target');";
    const after = "console.log(`  unscanned: ${n}`);\nconsole.log('design target');";
    expect(kinds(before, after, BENCH)).toEqual(['bench-string', 'bench-string']);
  });

  it('each replaced token is judged alone, so an allowed one cannot carry its neighbour', () => {
    const before = "log('unscanned (R86)' + n);";
    expect(kinds(before, "log('unscanned' - n);", BENCH)).toEqual(['bench-string', 'code']);
  });

  it('but not outside bench/src, not in its tests, not without a reference, and not keeping one', () => {
    const before = "log('unscanned (R86)');";
    expect(kinds(before, "log('unscanned');", SOURCE)).toEqual(['code']);
    expect(kinds(before, "log('unscanned');", 'bench/src/report.test.ts')).toEqual(['code']);
    expect(kinds("log('unscanned');", "log('not scanned');", BENCH)).toEqual(['code']);
    expect(kinds(before, "log('unscanned (R87)');", BENCH)).toEqual(['code']);
    expect(kinds('log(`a ${x} (R86)`);', 'log(`a ${y}`);', BENCH)).toContain('code');
  });
});

describe('the script itself', () => {
  const repos: string[] = [];
  afterEach(() => {
    for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
  });

  function git(repo: string, ...args: string[]) {
    return execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: repo, encoding: 'utf8' },
    );
  }

  function write(repo: string, files: Record<string, string>) {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, file)), { recursive: true });
      writeFileSync(join(repo, file), text);
    }
  }

  function repository(files: Record<string, string>) {
    const repo = mkdtempSync(join(realpathSync.native(tmpdir()), 'upfly-token-diff-'));
    repos.push(repo);
    git(repo, 'init', '--quiet');
    git(repo, 'config', 'core.autocrlf', 'false');
    write(repo, files);
    git(repo, 'add', '.');
    git(repo, 'commit', '--quiet', '-m', 'base');
    return repo;
  }

  function run(repo: string, ...args: string[]) {
    const result = spawnSync(process.execPath, [SCRIPT, '--root', repo, ...args], {
      encoding: 'utf8',
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }

  const base = {
    [SOURCE]: '// R184 — why\nexport const a = 1;\n',
    [TEST]: "it('R181 (b′)', () => {\n  expect(1).toBe(1);\n});\n",
    'README.md': 'text\n',
  };

  it('passes a comment-only change, and prints a renamed title as its own kind', () => {
    const repo = repository(base);
    write(repo, {
      [SOURCE]: '// Why, as a fact.\nexport const a = 1;\n',
      [TEST]: "it('keeps the original', () => {\n  expect(1).toBe(1);\n});\n",
      'README.md': 'new text\n',
    });
    const { status, output } = run(repo);
    expect(status).toBe(0);
    expect(output).toContain(`${TEST}:\n  test title, line 1 to line 1:`);
    expect(output).toContain("    - 'R181 (b′)'\n    + 'keeps the original'");
    expect(output).toContain('Not source, so not compared: README.md (modified).');
    expect(output).toContain('Compared 2 files: 1 differ only in comments and whitespace.');
    expect(output).toContain('No change outside comments and the allowed kinds.');
  });

  it('fails on a planted code change, naming the file and the line', () => {
    const repo = repository(base);
    write(repo, { [SOURCE]: '// R184 — why\nexport const a = 2;\n' });
    const { status, output } = run(repo);
    expect(status).toBe(1);
    expect(output).toContain(`${SOURCE}:\n  code change, line 2 to line 2:\n    - 1\n    + 2`);
    expect(output).toContain('1 change outside comments and the allowed kinds.');
  });

  it('fails on test data, and on a source file added or deleted', () => {
    const repo = repository({ ...base, 'fixtures/site/a.js': '// R1\nf();\n' });
    write(repo, {
      'fixtures/site/a.js': '// one\nf();\n',
      'packages/demo/src/new.ts': 'export {};\n',
    });
    rmSync(join(repo, TEST));
    const { status, output } = run(repo);
    expect(status).toBe(1);
    expect(output).toContain('fixtures/site/a.js: test data modified.');
    expect(output).toContain('packages/demo/src/new.ts: source file added.');
    expect(output).toContain(`${TEST}: source file deleted.`);
  });

  it('compares two commits, limited to the paths given', () => {
    const repo = repository(base);
    write(repo, { [SOURCE]: 'export const a = 3;\n', [TEST]: "it('one', () => {});\n" });
    git(repo, 'commit', '--quiet', '-am', 'next');
    const all = run(repo, '--base', 'HEAD~1', '--head', 'HEAD');
    expect(all.status).toBe(1);
    const onlyTest = run(
      repo,
      '--base',
      'HEAD~1',
      '--head',
      'HEAD',
      'packages/demo/src/demo.test.ts',
    );
    expect(onlyTest.output).toContain('1 changed file.');
  });

  it('exits 2 on an argument it does not know', () => {
    expect(run(repository(base), '--nope')).toEqual({
      status: 2,
      output: 'token-diff: unknown argument: --nope\n',
    });
  });
});
