/**
 * 🔴 PROVES THE SELF-CHECK CAN FAIL.
 *
 * A guard that has never failed is not known to work. This project has shipped four
 * guards that never fired once, and a fixture's premise is the first thing an innocent
 * edit destroys — so the checker is not trusted until it has been watched going red for
 * each class of damage it claims to catch.
 *
 * Every mutation is applied to a COPY in the system temp directory. The real tree is
 * never written to, which is spec §6: the tree is read-only ground truth, and anything
 * that writes works on a copy.
 *
 * Usage:  node tools/prove-can-fail.mjs [--keep]
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const here = resolve(process.argv[1], '..', '..');
const keep = process.argv.includes('--keep');

/**
 * Each case damages the copy in one specific way and names the words the checker must
 * say. Asserting on the MESSAGE and not merely on the exit code is the point: a checker
 * that fails for the wrong reason is as useless as one that passes.
 */
const cases = [
  {
    name: 'a raw in the key no longer matches the file',
    damage: (root) => editKey(root, (key) => {
      key.files[0].entries[0].raw = `${key.files[0].entries[0].raw}X`;
    }),
    expect: 'not the recorded raw',
  },
  {
    name: 'a reference is deleted from the key',
    damage: (root) => editKey(root, (key) => {
      key.files[0].entries.splice(0, 1);
    }),
    expect: 'which the key does not list',
  },
  {
    name: 'a new reference is added to the tree and not to the key',
    damage: (root) =>
      appendFileSync(
        join(root, 'tree/apps/web/index.html'),
        '\n<img src="/gallery/photo.png" alt="Added behind the key\'s back" />\n',
      ),
    expect: 'which the key does not list',
  },
  {
    name: 'a blank line is inserted, shifting every offset below it',
    damage: (root) => {
      const file = join(root, 'tree/apps/web/index.html');
      writeFileSync(file, `\n${readFileSync(file, 'utf8')}`);
    },
    expect: 'not the recorded raw',
  },
  {
    name: "an asset's recorded byte size is wrong",
    damage: (root) => editKey(root, (key) => {
      key.assets[0].bytes += 1;
    }),
    expect: 'bytes, disk has',
  },
  {
    name: "an asset's recorded hash is wrong",
    damage: (root) => editKey(root, (key) => {
      key.assets[0].sha256 = '0000000000000000';
    }),
    expect: 'disk has',
  },
  {
    name: 'an asset listed in the key is deleted from the tree',
    damage: (root) => {
      const key = JSON.parse(readFileSync(join(root, 'key/coverage-key.json'), 'utf8'));
      rmSync(join(root, 'tree', key.assets[0].path));
    },
    expect: 'listed but not on disk',
  },
  {
    name: 'an asset is added to the tree and not to the key',
    damage: (root) =>
      cpSync(
        join(root, 'tree/apps/web/public/brand.png'),
        join(root, 'tree/apps/web/public/smuggled.png'),
      ),
    expect: 'on disk but not in the key',
  },
  {
    name: 'a target names a file that does not exist',
    damage: (root) => editKey(root, (key) => {
      const entry = findEntry(key, (e) => e.expect === 'resolved');
      entry.target = 'apps/web/public/no-such-file.png';
    }),
    expect: 'neither a listed asset nor a file in the tree',
  },
  {
    name: 'a resolved entry loses its target',
    damage: (root) => editKey(root, (key) => {
      delete findEntry(key, (e) => e.expect === 'resolved').target;
    }),
    expect: 'requires a target',
  },
  {
    name: 'an expect value is not one of the seven outcomes',
    damage: (root) => editKey(root, (key) => {
      findEntry(key, (e) => e.expect === 'resolved').expect = 'probably-fine';
    }),
    expect: 'unknown expect',
  },
  {
    name: 'a relative reference points somewhere its target is not',
    damage: (root) => editKey(root, (key) => {
      const entry = findEntry(
        key,
        (e) => e.expect === 'resolved' && /^\.{1,2}\//.test(e.raw) && !/[?#]/.test(e.raw),
      );
      entry.target = 'shared/assets/img/thumb.png';
    }),
    expect: 'relative path resolves to',
  },
  {
    name: 'an occurrence index is one too low, hiding a reference inside another',
    damage: (root) => editKey(root, (key) => {
      // apps/web/src/lib/paths.ts holds `/srcset/` twice, the first inside a template
      // literal that is itself a keyed reference. Dropping the index to 1 stamps this
      // entry inside that one.
      const group = key.files.find((f) => f.path === 'apps/web/src/lib/paths.ts');
      const entry = group.entries.find((e) => e.raw === '/srcset/');
      entry.occurrence = 1;
      entry.offset -= 633;
    }),
    expect: 'overlap',
  },
  {
    name: 'a declared shape has no references and no reason',
    damage: (root) => editKey(root, (key) => {
      key.shapes.push({ id: 'html.invented.position', label: 'invented', spec: '-', motivation: '-' });
    }),
    expect: 'no `absent` reason',
  },
  {
    name: 'a shape drops below three instances and does not say why',
    damage: (root) => editKey(root, (key) => {
      const group = key.files.find((f) => f.path === 'apps/web/media.html');
      let seen = 0;
      group.entries = group.entries.filter((e) => {
        if (e.shape !== 'html.input.src') return true;
        seen += 1;
        return seen === 1;
      });
      // Removing entries leaves their occurrences unlisted, which is a different
      // failure; allowlist them so the shape rule is what actually fires.
      key.unreferencedOccurrences = key.unreferencedOccurrences ?? [];
    }),
    expect: 'asks for three to five',
  },
  {
    name: 'the checker gains an import of something that is not node: or ./',
    damage: (root) => {
      const file = join(root, 'tools/check-key.mjs');
      const source = readFileSync(file, 'utf8');
      writeFileSync(
        file,
        source.replace(
          "import { createHash } from 'node:crypto';",
          "import { createHash } from 'node:crypto';\nif (globalThis.__never) { require('upfly-core'); }",
        ),
      );
    },
    expect: 'dynamic import that is not node',
  },
  {
    name: 'an UNDECIDED entry, under --strict',
    damage: () => {},
    args: ['--strict'],
    expect: 'OPEN QUESTIONS',
  },
  {
    name: 'an UNDECIDED entry with fewer than two candidate outcomes',
    damage: (root) => editKey(root, (key) => {
      findEntry(key, (e) => e.expect === 'UNDECIDED').candidates = ['resolved'];
    }),
    expect: 'at least two candidate outcomes',
  },
];

function editKey(root, mutate) {
  const path = join(root, 'key/coverage-key.json');
  const key = JSON.parse(readFileSync(path, 'utf8'));
  mutate(key);
  writeFileSync(path, `${JSON.stringify(key, null, 2)}\n`);
}

function findEntry(key, predicate) {
  for (const group of key.files) {
    for (const entry of group.entries) if (predicate(entry)) return entry;
  }
  throw new Error('no entry matched');
}

function run(root, args = []) {
  return spawnSync(process.execPath, [join(root, 'tools/check-key.mjs'), ...args], {
    encoding: 'utf8',
  });
}

/* ------------------------------------------------------------------------------------- */

const baseline = run(here);
if (baseline.status !== 0) {
  process.stdout.write(
    'The undamaged tree does not pass its own check, so nothing here would mean anything.\n',
  );
  process.stdout.write(baseline.stdout);
  process.exitCode = 1;
} else {
  process.stdout.write('baseline: the undamaged tree passes\n\n');

  let failures = 0;
  for (const testCase of cases) {
    const root = mkdtempSync(join(tmpdir(), 'coverage-tree-proof-'));
    try {
      for (const dir of ['tree', 'key', 'tools']) {
        cpSync(join(here, dir), join(root, dir), { recursive: true });
      }
      testCase.damage(root);
      const result = run(root, testCase.args ?? []);
      const output = `${result.stdout}${result.stderr}`;

      const wentRed = result.status !== 0;
      const saidWhy = testCase.expectExitOnly || output.includes(testCase.expect);

      if (wentRed && saidWhy) {
        process.stdout.write(`  RED   ${testCase.name}\n`);
      } else {
        failures += 1;
        process.stdout.write(`  MISS  ${testCase.name}\n`);
        process.stdout.write(
          `        exit ${result.status}` +
            (testCase.expectExitOnly ? '' : `, expected to say ${JSON.stringify(testCase.expect)}`) +
            '\n',
        );
        if (!wentRed) process.stdout.write('        🔴 THE CHECKER STAYED GREEN ON DAMAGE.\n');
      }
    } finally {
      if (!keep) rmSync(root, { recursive: true, force: true });
      else process.stdout.write(`        kept: ${root}\n`);
    }
  }

  process.stdout.write(
    failures === 0
      ? `\nAll ${cases.length} mutations turned the check red. The guard is known to work.\n`
      : `\n${failures} of ${cases.length} mutations did NOT fail the check. The guard is not trustworthy.\n`,
  );
  if (failures > 0) process.exitCode = 1;
}
