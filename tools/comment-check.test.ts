import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { analyseSource, countFindings } from './comment-check.mjs';

const SCRIPT = fileURLToPath(new URL('./comment-check.mjs', import.meta.url));
const SHIPPED = 'packages/demo/src/demo.ts';
const NOT_SHIPPED = 'bench/src/demo.ts';
const EM_DASH = '—';

function countsOf(text: string, file = NOT_SHIPPED) {
  return countFindings(analyseSource(text, file));
}

function lineComments(count: number) {
  return Array.from({ length: count }, (_, i) => `// line ${i + 1} of the note`).join('\n');
}

describe('each rule catches what it names', () => {
  it.each([
    ['a ruling number', '// fixed in R184'],
    ['a plan section', '// see §5.1'],
    ['a chat name', '// measured by B15'],
    ['a chat name with a part', '// owned by C2a'],
    ['a notes path', '// the reasoning is in notes/STATE.md'],
    ['the parent chat', '// raised with the parent chat'],
    ['a lesson label', '// the same trap as 6a-septies'],
    ['a plan phase', '// arrives in Phase 2'],
  ])('%s is an internal reference', (_, comment) => {
    expect(countsOf(comment)).toEqual({ 'internal-reference': 1 });
  });

  it('an em dash', () => {
    expect(countsOf(`// one ${EM_DASH} two`)).toEqual({ 'em-dash': 1 });
  });

  it.each([
    ['bold', '// this is **important**'],
    ['bold with underscores', '// this is __important__'],
    ['italics', '// this is *important*'],
    ['italics with underscores', '// this is _important_'],
  ])('markdown %s', (_, comment) => {
    expect(countsOf(comment)).toEqual({ emphasis: 1 });
  });

  it.each([
    ['a warning sign', '// ⚠️ careful'],
    ['a red circle', '// \u{1f534} careful'],
    ['a check mark', '// ✅ done'],
  ])('an emoji: %s', (_, comment) => {
    expect(countsOf(comment)).toEqual({ emoji: 1 });
  });

  it('counts each line past the tenth in a block of line comments', () => {
    expect(countsOf(lineComments(10))).toEqual({});
    expect(countsOf(lineComments(11))).toEqual({ 'long-comment': 1 });
    expect(countsOf(lineComments(14))).toEqual({ 'long-comment': 4 });
  });

  it('counts a long block comment the same way', () => {
    const body = Array.from({ length: 12 }, (_, i) => ` * sentence ${i + 1}`).join('\n');
    expect(countsOf(`/**\n${body}\n */\nexport const x = 1;`)).toEqual({ 'long-comment': 2 });
  });

  it('an internal reference in a string a package ships', () => {
    const source = "export const reason = 'too little is fixed (R80)';";
    expect(countsOf(source, SHIPPED)).toEqual({ 'output-reference': 1 });
    expect(countsOf('export const reason = `${1}: see notes/STATE.md`;', SHIPPED)).toEqual({
      'output-reference': 1,
    });
  });

  it('reports the line each finding is on', () => {
    const findings = analyseSource(`const a = 1;\n\n// one ${EM_DASH} two\n`, NOT_SHIPPED);
    expect(findings.map(({ rule, line }) => ({ rule, line }))).toEqual([
      { rule: 'em-dash', line: 3 },
    ]);
  });
});

describe('what must not trip it', () => {
  it('a JSDoc opener and its gutter, including a bulleted list', () => {
    const source = '/**\n * Lists what it holds:\n * - one\n * * two\n */\nexport const x = 1;';
    expect(countsOf(source)).toEqual({});
  });

  it('a ruling-shaped name inside a URL', () => {
    const comment = '// https://developers.cloudflare.com/R2/ and https://example.com/issues/B15';
    expect(countsOf(comment)).toEqual({});
  });

  it('a backticked identifier holding underscores or asterisks', () => {
    expect(countsOf('// `__dirname`, `**/*.test.ts` and `_private_` are code')).toEqual({});
  });

  it('a dash, a ruling number or an emoji inside a string or template literal', () => {
    const source = [
      `const label = 'before ${EM_DASH} after';`,
      "const note = 'fixed in R184 ⚠';",
      `const text = \`\${label} ${EM_DASH} \${note}\`;`,
    ].join('\n');
    expect(countsOf(source)).toEqual({});
  });

  it('comment markers inside a string, a template literal or a regular expression', () => {
    const source = [
      "const url = 'http://example.com // **not** a comment R184';",
      `const pattern = /\\/\\/ also not ${EM_DASH} a comment R184/;`,
      'const text = `/* nor ${1 + 1} **this** */`;',
      `const ratio = 4 / 2; // a real comment ${EM_DASH} after division`,
    ].join('\n');
    expect(countsOf(source)).toEqual({ 'em-dash': 1 });
  });

  it('multiplication and globs written without backticks', () => {
    expect(countsOf('// width * height * 2, and src/**/*.ts beside lib/**/*.js')).toEqual({});
  });

  it('JSDoc API sections, however long', () => {
    const params = Array.from({ length: 8 }, (_, i) => ` * @param p${i} the value ${i}`);
    const example = [' * @example', ...Array.from({ length: 6 }, (_, i) => ` * run(${i});`)];
    const source = ['/**', ' * Runs it.', ...params, ...example, ' */'].join('\n');
    expect(countsOf(`${source}\nexport function run() {}`)).toEqual({});
  });

  it('an internal reference in a test file string, or in bench', () => {
    const source = "const title = 'the case R80 ruled';";
    expect(countsOf(source, 'packages/demo/src/demo.test.ts')).toEqual({});
    expect(countsOf(source, NOT_SHIPPED)).toEqual({});
  });
});

describe('the script itself', () => {
  const trees: string[] = [];
  afterEach(() => {
    for (const tree of trees.splice(0)) rmSync(tree, { recursive: true, force: true });
  });

  function tree(files: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), 'upfly-comment-check-'));
    trees.push(root);
    for (const [file, text] of Object.entries(files)) write(root, file, text);
    return root;
  }

  function write(root: string, file: string, text: string) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }

  function run(root: string, ...args: string[]) {
    const result = spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], {
      encoding: 'utf8',
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }

  it.each([
    ['internal-reference', NOT_SHIPPED, '// fixed in R184\nexport {};\n'],
    ['em-dash', NOT_SHIPPED, `// one ${EM_DASH} two\nexport {};\n`],
    ['emphasis', NOT_SHIPPED, '// this is **important**\nexport {};\n'],
    ['emoji', NOT_SHIPPED, '// \u{1f534} careful\nexport {};\n'],
    ['long-comment', NOT_SHIPPED, `${lineComments(11)}\nexport {};\n`],
    ['output-reference', SHIPPED, "export const reason = 'too open (R80)';\n"],
  ])('fails on one planted %s, naming the rule, the file and the line', (rule, file, text) => {
    const { status, output } = run(tree({ [file]: text }));
    expect(status).toBe(1);
    expect(output).toContain('Comment check: 1 file with findings.');
    expect(output).toContain(`${file}: ${rule}, 1.`);
    expect(output).toMatch(/line \d+:/);
  });

  it('reads the source files at the root, such as vitest.config.ts, but no other folder', () => {
    const planted = `// one ${EM_DASH} two\nexport {};\n`;
    const root = tree({
      'vitest.config.ts': planted,
      'docs/demo.ts': planted,
      'fixtures/site/demo.js': planted,
      'folder.mjs/notes.txt': 'a folder named like a source file\n',
    });
    const { status, output } = run(root);
    expect(status).toBe(1);
    expect(output).toContain('Comment check: 1 file with findings.');
    expect(output).toContain('vitest.config.ts: em-dash, 1.');
  });

  it('passes a clean tree, and the inputs that must not trip it', () => {
    const root = tree({
      [SHIPPED]: [
        '/** Says what it is for. */',
        `export const label = 'before ${EM_DASH} after';`,
        '// See https://developers.cloudflare.com/R2/ for `__dirname` and `**/*.ts`.',
        'export const x = 1;',
      ].join('\n'),
    });
    expect(run(root)).toEqual({
      status: 0,
      output: 'Comment check: 1 file checked, no findings.\n',
    });
  });

  it('counts every finding of a rule in a file, and reads no baseline that excuses them', () => {
    const file = 'bench/src/old.ts';
    const root = tree({
      [file]: `// a ${EM_DASH} b ${EM_DASH} c\nexport {};\n`,
      'tools/comment-baseline.json': JSON.stringify({ files: { [file]: { 'em-dash': 2 } } }),
    });
    const { status, output } = run(root);
    expect(status).toBe(1);
    expect(output).toContain(`${file}: em-dash, 2.`);
  });

  it.each([['--nope'], ['--update'], ['--baseline']])(
    'exits 2 on %s, which it does not know',
    (arg) => {
      expect(run(tree({}), arg)).toEqual({
        status: 2,
        output: `comment-check: unknown argument: ${arg}\n`,
      });
    },
  );
});
