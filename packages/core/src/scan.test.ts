import { describe, expect, it, vi } from 'vitest';
import { UpflyError } from './errors.js';
import { type ReadFilePort, scanSources } from './scan.js';
import type { Adapter, RawReference, SourceFile } from './types.js';

/**
 * `scan` owns error handling for every adapter, so the interesting cases are all
 * failures: a file that will not parse, a file that vanished, an adapter that
 * throws something nobody expected.
 *
 * Because `readFile` is an injected port, every one of those is an entry in a plain
 * object rather than a temp tree full of deliberately broken files — which is the
 * argument for the port more than purity is.
 */

function sourceFile(relative: string, adapterId: string): SourceFile {
  const extension = relative.slice(relative.lastIndexOf('.'));
  return { path: `/repo/${relative}`, relative, extension, adapterId };
}

/** A port backed by an object. A missing key rejects the way `fs` would. */
function filesystem(files: Record<string, string>): ReadFilePort {
  return async (path) => {
    const text = files[path];
    if (text === undefined) {
      throw Object.assign(new Error(`ENOENT: no such file, open '${path}'`), { code: 'ENOENT' });
    }
    return text;
  };
}

/** An adapter that reports one reference per line of the form `ref:<path>`. */
function lineAdapter(id: string, extensions: readonly string[]): Adapter {
  return {
    id,
    extensions,
    findReferences: ({ file, text }) => {
      const found: RawReference[] = [];
      let offset = 0;
      for (const line of text.split('\n')) {
        if (line.startsWith('ref:')) {
          const start = offset + 'ref:'.length;
          found.push({
            file,
            start,
            end: start + line.length - 'ref:'.length,
            rawPath: line.slice('ref:'.length),
            kind: 'attr',
            ceiling: 'high',
            asserted: true,
          });
        }
        offset += line.length + 1;
      }
      return found;
    },
    rewrite: ({ text }) => text,
  };
}

const html = lineAdapter('html', ['.html']);
const css = lineAdapter('css', ['.css']);
const adapters = [html, css];

describe('scanSources', () => {
  it('reads each file and returns what its adapter found', async () => {
    const result = await scanSources({
      sourceFiles: [sourceFile('index.html', 'html'), sourceFile('app.css', 'css')],
      adapters,
      readFile: filesystem({
        '/repo/index.html': 'ref:hero.png',
        '/repo/app.css': 'ref:bg.jpg\nref:logo.png',
      }),
    });

    expect(result.references.map((reference) => reference.rawPath)).toEqual([
      'hero.png',
      'bg.jpg',
      'logo.png',
    ]);
    expect(result.unscanned).toEqual([]);
  });

  it('hands each file to the adapter that claimed it', async () => {
    const seen: string[] = [];
    const recording: Adapter = {
      ...css,
      findReferences: ({ file }) => {
        seen.push(file);
        return [];
      },
    };

    await scanSources({
      sourceFiles: [sourceFile('index.html', 'html'), sourceFile('app.css', 'css')],
      adapters: [html, recording],
      readFile: filesystem({ '/repo/index.html': '', '/repo/app.css': '' }),
    });

    expect(seen).toEqual(['/repo/app.css']);
  });

  it('preserves source-file order regardless of which read finishes first', async () => {
    // Rule 11 is only true if ordering is a property of the input, not of IO timing.
    const delays: Record<string, number> = { '/repo/a.html': 20, '/repo/b.html': 0 };
    const readFile: ReadFilePort = async (path) => {
      await new Promise((done) => setTimeout(done, delays[path] ?? 0));
      return `ref:${path}`;
    };

    const result = await scanSources({
      sourceFiles: [sourceFile('a.html', 'html'), sourceFile('b.html', 'html')],
      adapters,
      readFile,
    });

    expect(result.references.map((reference) => reference.rawPath)).toEqual([
      '/repo/a.html',
      '/repo/b.html',
    ]);
  });

  it('produces identical output across concurrency settings', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`/repo/f${index}.html`, `ref:img${index}.png`]),
    );
    const sourceFiles = Array.from({ length: 40 }, (_, index) =>
      sourceFile(`f${index}.html`, 'html'),
    );

    const one = await scanSources({ sourceFiles, adapters, readFile: filesystem(files) });
    const many = await scanSources({
      sourceFiles,
      adapters,
      readFile: filesystem(files),
      concurrency: 7,
    });

    expect(many.references).toEqual(one.references);
  });

  describe('a file it could not read', () => {
    it('reports a parse failure instead of aborting the run', async () => {
      // The whole reason this module exists: one unparseable file in a repo must
      // not take the audit down with it.
      const throwing: Adapter = {
        ...css,
        findReferences: () => {
          throw new UpflyError('ADAPTER_PARSE_FAILED', 'Unclosed block at line 12.');
        },
      };

      const result = await scanSources({
        sourceFiles: [sourceFile('broken.css', 'css'), sourceFile('fine.html', 'html')],
        adapters: [html, throwing],
        readFile: filesystem({ '/repo/broken.css': 'a {', '/repo/fine.html': 'ref:hero.png' }),
      });

      expect(result.references.map((reference) => reference.rawPath)).toEqual(['hero.png']);
      expect(result.unscanned).toEqual([
        {
          path: '/repo/broken.css',
          relative: 'broken.css',
          extension: '.css',
          reason: 'parse-failed',
          detail: 'ADAPTER_PARSE_FAILED: Unclosed block at line 12.',
        },
      ]);
    });

    it('survives an adapter throwing something that is not an UpflyError', async () => {
      // Adapters are the contribution surface. A bug in a community adapter must
      // not take down an audit of a repo that adapter barely touches — and it must
      // be visible in the report rather than merely survived.
      const buggy: Adapter = {
        ...css,
        findReferences: () => {
          throw new TypeError('Cannot read properties of undefined (reading "value")');
        },
      };

      const result = await scanSources({
        sourceFiles: [sourceFile('app.css', 'css')],
        adapters: [buggy],
        readFile: filesystem({ '/repo/app.css': 'body {}' }),
      });

      expect(result.unscanned[0]?.reason).toBe('parse-failed');
      expect(result.unscanned[0]?.detail).toContain('Cannot read properties of undefined');
    });

    it('reports a file that vanished between the walk and the read', async () => {
      // §5.1(e): a file that disappears mid-run degrades, it does not crash.
      const result = await scanSources({
        sourceFiles: [sourceFile('gone.html', 'html'), sourceFile('here.html', 'html')],
        adapters,
        readFile: filesystem({ '/repo/here.html': 'ref:hero.png' }),
      });

      expect(result.references).toHaveLength(1);
      expect(result.unscanned).toEqual([
        {
          path: '/repo/gone.html',
          relative: 'gone.html',
          extension: '.html',
          reason: 'unreadable',
          detail: 'ENOENT',
        },
      ]);
    });

    it('describes a rejection that carries no errno', async () => {
      const result = await scanSources({
        sourceFiles: [sourceFile('a.html', 'html')],
        adapters,
        readFile: async () => {
          throw new Error('the port is misconfigured');
        },
      });

      expect(result.unscanned[0]?.detail).toBe('the port is misconfigured');
    });

    it('describes a rejection that is not an Error at all', async () => {
      const result = await scanSources({
        sourceFiles: [sourceFile('a.html', 'html')],
        adapters,
        readFile: async () => {
          // Deliberately hostile: a port that throws a bare string.
          throw 'nope';
        },
      });

      expect(result.unscanned[0]?.detail).toBe('nope');
    });
  });

  it('throws when a file names an adapter that was not supplied', async () => {
    // A wiring mistake, not a data problem: scanning with a different adapter set
    // than discovery used. Silently skipping the file would make its assets look
    // dead, which is the failure this whole layer exists to prevent.
    const readFile = vi.fn(filesystem({}));

    await expect(
      scanSources({ sourceFiles: [sourceFile('page.vue', 'vue')], adapters, readFile }),
    ).rejects.toThrow(expect.objectContaining({ code: 'ADAPTER_NOT_REGISTERED' }));
    expect(readFile).not.toHaveBeenCalled();
  });

  it('scans nothing without complaint', async () => {
    const result = await scanSources({ sourceFiles: [], adapters, readFile: filesystem({}) });

    expect(result).toEqual({ references: [], unscanned: [] });
  });
});
