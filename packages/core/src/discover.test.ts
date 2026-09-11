import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discover } from './discover.js';
import { UpflyError } from './errors.js';
import type { Adapter } from './types.js';

/**
 * `discover` is one of the two modules that is *supposed* to touch a disk, so it is
 * tested against a real temporary tree rather than a mock. Mocking `fs` here would
 * test our idea of the filesystem instead of the filesystem.
 */

const createdRoots: string[] = [];

afterEach(async () => {
  for (const root of createdRoots.splice(0)) {
    // Permissions are dropped in some tests; restore them so cleanup can succeed.
    await chmod(root, 0o755).catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

/** Build a temp tree. A key ending in `/` creates an empty directory. */
async function makeTree(entries: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'upfly-discover-'));
  createdRoots.push(root);

  for (const [relative, contents] of Object.entries(entries)) {
    const full = join(root, relative);
    if (relative.endsWith('/')) {
      await mkdir(full, { recursive: true });
      continue;
    }
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, contents);
  }
  return root;
}

/** A stand-in adapter: `discover` only ever reads `id` and `extensions`. */
function fakeAdapter(id: string, extensions: readonly string[]): Adapter {
  return {
    id,
    extensions,
    findReferences: () => [],
    rewrite: ({ text }) => text,
  };
}

const html = fakeAdapter('html', ['.html']);
const css = fakeAdapter('css', ['.css']);
const adapters = [html, css];

/** These tests drop permission bits, which Windows has no equivalent for; root ignores them. */
const cannotDropPermissions = process.platform === 'win32' || process.getuid?.() === 0;

describe('discover', () => {
  it('finds images and adapter-claimed source files, and nothing else', async () => {
    const root = await makeTree({
      'index.html': '<img src="hero.png">',
      'src/app.css': 'body {}',
      'src/hero.png': 'fake-png',
      'src/logo.svg': '<svg/>',
      'src/notes.txt': 'not claimed by any adapter',
      'README.md': 'no markdown adapter is registered in this test',
    });

    const result = await discover({ root, adapters });

    expect(result.assets.map((asset) => asset.relative)).toEqual(['src/hero.png', 'src/logo.svg']);
    expect(result.sourceFiles.map((file) => file.relative)).toEqual(['index.html', 'src/app.css']);
    expect(result.skipped).toEqual([]);
  });

  it('records the adapter that claimed each source file', async () => {
    const root = await makeTree({ 'a.html': '', 'b.css': '' });

    const result = await discover({ root, adapters });

    expect(result.sourceFiles.map((file) => [file.relative, file.adapterId])).toEqual([
      ['a.html', 'html'],
      ['b.css', 'css'],
    ]);
  });

  it('reports each asset with its size and lowercase extension', async () => {
    const root = await makeTree({ 'HERO.PNG': 'twelve bytes' });

    const result = await discover({ root, adapters });

    expect(result.assets).toEqual([
      {
        path: join(root, 'HERO.PNG'),
        relative: 'HERO.PNG',
        extension: '.png',
        bytes: 12,
      },
    ]);
  });

  it('prunes the default-ignored directories without descending into them', async () => {
    const root = await makeTree({
      'keep.png': '',
      'node_modules/pkg/dead.png': '',
      'dist/built.png': '',
      '.git/objects/thing.png': '',
      'src/nested/deep/real.png': '',
    });

    const result = await discover({ root, adapters });

    expect(result.assets.map((asset) => asset.relative)).toEqual([
      'keep.png',
      'src/nested/deep/real.png',
    ]);
    // Three pruned directories, counted once each rather than once per file inside.
    expect(result.ignoredCount).toBe(3);
  });

  it('applies .upflyignore patterns for files, directories and negations', async () => {
    const root = await makeTree({
      '.upflyignore': ['*.png', '!keep.png', 'vendor/', 'docs/draft.css'].join('\n'),
      'drop.png': '',
      'keep.png': '',
      'keep.webp': '',
      'vendor/bundled.png': '',
      'docs/draft.css': '',
      'docs/real.css': '',
    });

    const result = await discover({ root, adapters });

    expect(result.assets.map((asset) => asset.relative)).toEqual(['keep.png', 'keep.webp']);
    expect(result.sourceFiles.map((file) => file.relative)).toEqual(['docs/real.css']);
    // drop.png, the vendor/ directory, and docs/draft.css.
    expect(result.ignoredCount).toBe(3);
  });

  it('records each excluded directory with the rule that excluded it', async () => {
    const root = await makeTree({
      '.upflyignore': 'legacy/\n',
      'node_modules/pkg/a.png': '',
      'legacy/old.png': '',
      'keep.png': '',
    });

    const result = await discover({ root, adapters });

    // The likeliest real case is not node_modules but a user who ignores `legacy/`
    // while it is still referenced. Recording the rule is what lets the report say
    // *why* an asset went missing.
    expect(result.excludedRoots.map((entry) => [entry.relative, entry.reason])).toEqual([
      ['legacy', "the ignore rule 'legacy/'"],
      ['node_modules', "a build or version-control directory named 'node_modules'"],
    ]);
  });

  it('leaves excludedRoots empty when nothing was excluded', async () => {
    const root = await makeTree({ 'a.png': '', 'src/b.png': '' });

    expect((await discover({ root, adapters })).excludedRoots).toEqual([]);
  });

  describe('unscanned files', () => {
    it('records every file no adapter claimed, with its path', async () => {
      const root = await makeTree({
        'index.html': '',
        'src/hero.png': '',
        'src/notes.txt': '',
        'config.yaml': '',
        LICENSE: '',
      });

      const result = await discover({ root, adapters });

      // The path, not just the extension: the audit sweeps these files for the
      // filenames of zero-reference assets, and hedges per asset rather than
      // globally. A count alone could not name the file in the report.
      expect(result.unscannedFiles.map((file) => [file.relative, file.extension])).toEqual([
        ['LICENSE', ''],
        ['config.yaml', '.yaml'],
        ['src/notes.txt', '.txt'],
      ]);
      expect(result.unscannedFiles.every((file) => file.reason === 'unclaimed-extension')).toBe(
        true,
      );
    });

    it('records an SVG as an asset AND as unscanned', async () => {
      const root = await makeTree({ 'icons/sprite.svg': '<svg/>', 'hero.png': '' });

      const result = await discover({ root, adapters });

      // An SVG is both. `<image href="hero.png">` inside a sprite is a real
      // reference no adapter reads, so an asset mentioned only there must not be
      // reported as confidently dead.
      expect(result.assets.map((asset) => asset.relative)).toEqual([
        'hero.png',
        'icons/sprite.svg',
      ]);
      expect(result.unscannedFiles.map((file) => file.relative)).toEqual(['icons/sprite.svg']);
    });

    it('does not record other image formats as unscanned', async () => {
      const root = await makeTree({ 'a.png': '', 'b.jpg': '', 'c.webp': '' });

      // A PNG cannot reference another asset, so listing one would be noise in the
      // report's coverage statement and cost the audit a pointless read.
      expect((await discover({ root, adapters })).unscannedFiles).toEqual([]);
    });

    it('does not record ignored or excluded entries', async () => {
      const root = await makeTree({
        '.upflyignore': 'legacy/\nsecrets.txt\n',
        'legacy/old.vue': '',
        'node_modules/pkg/index.vue': '',
        'secrets.txt': '',
        'app.vue': '',
      });

      const result = await discover({ root, adapters });

      // An ignore rule is an instruction, not a gap in our coverage — hedging a
      // report on a directory the user told us to skip would be dishonest in the
      // other direction, and walking a pruned node_modules to do it is absurd.
      // `.upflyignore` is absent because we read it; it is not a file we failed on.
      expect(result.unscannedFiles.map((file) => file.relative)).toEqual(['app.vue']);
    });

    it('does not record the ignore file it read, under any name', async () => {
      const root = await makeTree({ '.upflyrc': 'legacy/\n', 'a.png': '' });

      const result = await discover({ root, adapters, ignoreFile: '.upflyrc' });

      expect(result.unscannedFiles).toEqual([]);
    });

    it('leaves unscannedFiles empty when every file was claimed', async () => {
      const root = await makeTree({ 'index.html': '', 'app.css': '', 'hero.png': '' });

      // The case where a `dead` finding can be made confidently.
      expect((await discover({ root, adapters })).unscannedFiles).toEqual([]);
    });
  });

  it('applies extraIgnores as if appended to the ignore file', async () => {
    const root = await makeTree({ 'a.png': '', 'temp/b.png': '' });

    const result = await discover({ root, adapters, extraIgnores: ['temp/'] });

    expect(result.assets.map((asset) => asset.relative)).toEqual(['a.png']);
    expect(result.ignoredCount).toBe(1);
  });

  it('honours a custom ignore-file name', async () => {
    const root = await makeTree({ '.customignore': '*.png', 'a.png': '', 'b.webp': '' });

    const result = await discover({ root, adapters, ignoreFile: '.customignore' });

    expect(result.assets.map((asset) => asset.relative)).toEqual(['b.webp']);
  });

  it('treats a missing ignore file as the normal case, not a skip', async () => {
    const root = await makeTree({ 'a.png': '' });

    const result = await discover({ root, adapters });

    expect(result.skipped).toEqual([]);
    expect(result.assets).toHaveLength(1);
  });

  it('handles non-ASCII filenames', async () => {
    const root = await makeTree({ 'assets/héro-café.png': '', 'assets/日本語.webp': '' });

    const result = await discover({ root, adapters });

    expect(result.assets.map((asset) => asset.relative)).toEqual([
      'assets/héro-café.png',
      'assets/日本語.webp',
    ]);
  });

  it('produces identical output across runs and across concurrency settings', async () => {
    const root = await makeTree({
      'z/last.png': '',
      'a/first.png': '',
      'm/middle.html': '',
      'B/upper.png': '',
      'a/b/c/deep.css': '',
    });

    const [first, second, serial] = await Promise.all([
      discover({ root, adapters }),
      discover({ root, adapters }),
      discover({ root, adapters, concurrency: 1 }),
    ]);

    expect(second).toEqual(first);
    expect(serial).toEqual(first);
    expect(first.assets.map((asset) => asset.relative)).toEqual([
      'B/upper.png',
      'a/first.png',
      'z/last.png',
    ]);
  });

  it('does not follow symlinks, and says so', async () => {
    const root = await makeTree({ 'real/hero.png': '' });
    try {
      await symlink(join(root, 'real'), join(root, 'link'), 'dir');
    } catch {
      // Creating a symlink needs elevation or developer mode on Windows.
      return;
    }

    const result = await discover({ root, adapters });

    expect(result.assets.map((asset) => asset.relative)).toEqual(['real/hero.png']);
    expect(result.skipped).toEqual([
      { path: join(root, 'link'), relative: 'link', reason: 'symlink', detail: 'not followed' },
    ]);
  });

  it.skipIf(cannotDropPermissions)('records a directory it cannot read', async () => {
    const root = await makeTree({ 'locked/hidden.png': '', 'open.png': '' });
    await chmod(join(root, 'locked'), 0o000);

    const result = await discover({ root, adapters });
    await chmod(join(root, 'locked'), 0o755);

    expect(result.assets.map((asset) => asset.relative)).toEqual(['open.png']);
    expect(result.skipped).toEqual([
      {
        path: join(root, 'locked'),
        relative: 'locked',
        reason: 'unreadable-directory',
        detail: 'EACCES',
      },
    ]);
  });

  it.skipIf(cannotDropPermissions)('records a file it can list but cannot stat', async () => {
    // r without x on a directory: readdir returns the names, stat on them fails.
    const root = await makeTree({ 'listable/hero.png': '' });
    await chmod(join(root, 'listable'), 0o444);

    const result = await discover({ root, adapters });
    await chmod(join(root, 'listable'), 0o755);

    expect(result.assets).toEqual([]);
    expect(result.skipped).toEqual([
      {
        path: join(root, 'listable', 'hero.png'),
        relative: 'listable/hero.png',
        reason: 'unreadable-file',
        detail: 'EACCES',
      },
    ]);
  });

  it.skipIf(cannotDropPermissions)(
    'records an unreadable ignore file rather than failing the run',
    async () => {
      const root = await makeTree({ '.upflyignore': '*.png', 'a.png': '' });
      await chmod(join(root, '.upflyignore'), 0o000);

      const result = await discover({ root, adapters });
      await chmod(join(root, '.upflyignore'), 0o644);

      // The rules could not be read, so nothing is ignored — but that is visible.
      expect(result.assets.map((asset) => asset.relative)).toEqual(['a.png']);
      expect(result.skipped).toEqual([
        {
          path: join(root, '.upflyignore'),
          relative: '.upflyignore',
          reason: 'unreadable-file',
          detail: 'EACCES',
        },
      ]);
    },
  );

  it.skipIf(cannotDropPermissions)(
    'records an entry that is neither a file nor a directory',
    async () => {
      const root = await makeTree({ 'a.png': '' });
      const socketPath = join(root, 'daemon.sock');
      const server = createServer();
      await new Promise<void>((done) => server.listen(socketPath, done));

      const result = await discover({ root, adapters });
      await new Promise<void>((done) => server.close(() => done()));

      expect(result.assets.map((asset) => asset.relative)).toEqual(['a.png']);
      expect(result.skipped).toEqual([
        {
          path: socketPath,
          relative: 'daemon.sock',
          reason: 'not-a-regular-file',
          detail: 'neither a file nor a directory',
        },
      ]);
    },
  );

  it('rejects two adapters claiming the same extension', async () => {
    const root = await makeTree({ 'a.html': '' });
    const rival = fakeAdapter('other-html', ['.html']);

    await expect(discover({ root, adapters: [html, rival] })).rejects.toMatchObject({
      code: 'ADAPTER_EXTENSION_CONFLICT',
    });
  });

  it('rejects a root that does not exist', async () => {
    const root = join(tmpdir(), 'upfly-does-not-exist-4f2a9c');

    await expect(discover({ root, adapters })).rejects.toBeInstanceOf(UpflyError);
    await expect(discover({ root, adapters })).rejects.toMatchObject({
      code: 'ROOT_NOT_A_DIRECTORY',
    });
  });

  it('rejects a root that is a file', async () => {
    const root = await makeTree({ 'file.txt': '' });

    await expect(discover({ root: join(root, 'file.txt'), adapters })).rejects.toMatchObject({
      code: 'ROOT_NOT_A_DIRECTORY',
    });
  });

  it('returns an absolute, resolved root', async () => {
    const root = await makeTree({ 'a.png': '' });

    const result = await discover({ root: join(root, '.', 'nested', '..'), adapters });

    expect(result.root).toBe(root);
  });

  it('walks an empty project without complaint', async () => {
    const root = await makeTree({ 'empty/': '' });

    const result = await discover({ root, adapters });

    expect(result).toEqual({
      root,
      assets: [],
      sourceFiles: [],
      directories: ['empty'],
      ignoredCount: 0,
      skipped: [],
      excludedRoots: [],
      unscannedFiles: [],
    });
  });

  it('works with no adapters at all, finding only assets', async () => {
    const root = await makeTree({ 'a.png': '', 'b.html': '' });

    const result = await discover({ root, adapters: [] });

    expect(result.assets.map((asset) => asset.relative)).toEqual(['a.png']);
    expect(result.sourceFiles).toEqual([]);
  });

  describe('the walked directories', () => {
    it('lists every directory it descended into, sorted, without the root', async () => {
      const root = await makeTree({
        'index.html': '',
        'public/hero.png': '',
        'src/components/button.css': '',
        'src/hero.png': '',
      });

      const result = await discover({ root, adapters });

      expect(result.directories).toEqual(['public', 'src', 'src/components']);
    });

    it('lists a directory holding only files nothing tracks', async () => {
      // The case that decides why this is recorded rather than derived. Deriving
      // directories from the paths in `assets` and `sourceFiles` loses this one
      // entirely, and on shadcn-ui that is the difference between finding 12 serving
      // roots and finding 11: `templates/next-app/public` holds only a `.gitkeep`.
      const root = await makeTree({
        'public/.gitkeep': '',
        'static/robots.txt': '',
        'src/hero.png': '',
      });

      const result = await discover({ root, adapters });

      expect(result.assets.map((asset) => asset.relative)).toEqual(['src/hero.png']);
      expect(result.directories).toEqual(['public', 'src', 'static']);
    });

    it('lists an entirely empty directory', async () => {
      const root = await makeTree({ 'assets/': '', 'a.png': '' });

      const result = await discover({ root, adapters });

      expect(result.directories).toEqual(['assets']);
    });

    it('omits a directory an ignore rule excluded, because the walk never entered it', async () => {
      const root = await makeTree({
        '.upflyignore': 'legacy/\n',
        'legacy/public/old.png': '',
        'public/hero.png': '',
      });

      const result = await discover({ root, adapters });

      expect(result.directories).toEqual(['public']);
      expect(result.excludedRoots.map((excluded) => excluded.relative)).toEqual(['legacy']);
    });

    it('omits node_modules, which is where a detector would otherwise find hundreds', async () => {
      const root = await makeTree({
        'node_modules/some-package/public/demo.png': '',
        'public/hero.png': '',
      });

      const result = await discover({ root, adapters });

      expect(result.directories).toEqual(['public']);
    });
  });
});
