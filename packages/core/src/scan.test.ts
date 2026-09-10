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

    it('writes the relative path into the detail, never the absolute one', async () => {
      // §5.1(f) found this on `eleventy-docs`: `css.ts` and `javascript.ts` both
      // throw `Could not parse ${file}: …` with the absolute path they were handed,
      // and that message is carried verbatim into the report. One unparseable file
      // therefore puts `E:\…\combined.cjs` in the output and rule 11 becomes false —
      // the same repository audited from two checkouts produces different bytes.
      //
      // Invisible until now because **no fixture tree contains a file that fails to
      // parse**, so the report's own absolute-path guard had nothing to fire on.
      const throwing: Adapter = {
        ...css,
        findReferences: ({ file }) => {
          throw new UpflyError('ADAPTER_PARSE_FAILED', `Could not parse ${file}: Unexpected token`);
        },
      };

      const result = await scanSources({
        sourceFiles: [sourceFile('deep/nested/broken.css', 'css')],
        adapters: [throwing],
        readFile: filesystem({ '/repo/deep/nested/broken.css': 'a {' }),
      });

      expect(result.unscanned[0]?.detail).toBe(
        'ADAPTER_PARSE_FAILED: Could not parse deep/nested/broken.css: Unexpected token',
      );
      expect(result.unscanned[0]?.detail).not.toContain('/repo/');
    });

    it('scrubs a Windows-spelled absolute path out of the detail too', async () => {
      // The native separator is what an adapter actually interpolates on Windows,
      // and it is the platform rule 5 makes first-class. Built with `String.raw` so
      // the backslashes survive the file rather than becoming escapes.
      const path = String.raw`E:\repo\deep\broken.css`;
      const file: SourceFile = {
        path,
        relative: 'deep/broken.css',
        extension: '.css',
        adapterId: 'css',
      };
      const throwing: Adapter = {
        ...css,
        findReferences: (input) => {
          throw new UpflyError('ADAPTER_PARSE_FAILED', `Could not parse ${input.file}: bad token`);
        },
      };

      const result = await scanSources({
        sourceFiles: [file],
        adapters: [throwing],
        readFile: filesystem({ [path]: 'a {' }),
      });

      expect(result.unscanned[0]?.detail).toBe(
        'ADAPTER_PARSE_FAILED: Could not parse deep/broken.css: bad token',
      );
      expect(result.unscanned[0]?.detail).not.toContain('E:');
    });

    it('keeps the references an adapter found before it failed, and still reports it', async () => {
      // R20, at the layer that matters. Both halves have to hold at once: the file
      // is recorded as `parse-failed` so rule 9 is satisfied, **and** the references
      // collected before the failure survive — they are correct, and dropping them
      // is what made a referenced asset look dead.
      //
      // Before this, one `<style>` block of unparseable CSS inside a Markdown file
      // discarded every `![](hero.png)` above it.
      const partial: Adapter = {
        ...css,
        findReferences: ({ file }) => {
          throw new UpflyError('ADAPTER_PARSE_FAILED', 'bad CSS in a style block', [
            {
              file,
              start: 0,
              end: 9,
              rawPath: 'hero.png',
              kind: 'md' as const,
              ceiling: 'high' as const,
              asserted: true,
            },
          ]);
        },
      };

      const result = await scanSources({
        sourceFiles: [sourceFile('guide.css', 'css')],
        adapters: [partial],
        readFile: filesystem({ '/repo/guide.css': 'anything' }),
      });

      expect(result.references.map((reference) => reference.rawPath)).toEqual(['hero.png']);
      expect(result.unscanned.map((file) => [file.relative, file.reason])).toEqual([
        ['guide.css', 'parse-failed'],
      ]);
    });

    it('reports a failure carrying nothing exactly as it did before', async () => {
      // The control. Every other adapter throws without a payload, and that path has
      // to keep behaving identically — an empty `partial` must not become an excuse
      // to report something that was never found.
      const throwing: Adapter = {
        ...css,
        findReferences: () => {
          throw new UpflyError('ADAPTER_PARSE_FAILED', 'unclosed block');
        },
      };

      const result = await scanSources({
        sourceFiles: [sourceFile('a.css', 'css')],
        adapters: [throwing],
        readFile: filesystem({ '/repo/a.css': 'a {' }),
      });

      expect(result.references).toEqual([]);
      expect(result.unscanned[0]?.reason).toBe('parse-failed');
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

  describe('asset mentions, gathered while the text is in memory', () => {
    it('records an asset filename no adapter turned into a reference', async () => {
      // The audit's third haystack. Collected here rather than by re-reading the
      // tree later, which measured 12 s against a fraction of a second.
      const result = await scanSources({
        sourceFiles: [sourceFile('config.html', 'html')],
        adapters,
        readFile: filesystem({
          '/repo/config.html': ['a', 'b `/img/hero.png`', 'c'].join('\n'),
        }),
        assetBasenames: new Set(['hero.png']),
      });

      expect(result.mentions).toEqual([
        { basename: 'hero.png', relative: 'config.html', line: 2, quote: 'hero.png' },
      ]);
    });

    it('records nothing when no basenames were supplied', async () => {
      const result = await scanSources({
        sourceFiles: [sourceFile('a.html', 'html')],
        adapters,
        readFile: filesystem({ '/repo/a.html': 'hero.png' }),
      });

      expect(result.mentions).toEqual([]);
    });

    it('records one mention per basename per file', async () => {
      // A hundred repeats of a name are one piece of evidence, and the report cites
      // a place rather than a count.
      const result = await scanSources({
        sourceFiles: [sourceFile('a.html', 'html')],
        adapters,
        readFile: filesystem({ '/repo/a.html': 'hero.png hero.png hero.png' }),
        assetBasenames: new Set(['hero.png']),
      });

      expect(result.mentions).toHaveLength(1);
    });

    it('still records mentions from a file that failed to parse', async () => {
      // That file is precisely the one whose references we do not know, so its
      // mentions are the evidence that matters most.
      const throwing: Adapter = {
        ...css,
        findReferences: () => {
          throw new UpflyError('ADAPTER_PARSE_FAILED', 'unclosed block');
        },
      };

      const result = await scanSources({
        sourceFiles: [sourceFile('broken.css', 'css')],
        adapters: [throwing],
        readFile: filesystem({ '/repo/broken.css': 'a { background: url(hero.png) ' }),
        assetBasenames: new Set(['hero.png']),
      });

      expect(result.unscanned[0]?.reason).toBe('parse-failed');
      expect(result.mentions[0]?.basename).toBe('hero.png');
    });

    it('ignores a filename that is not an asset', async () => {
      const result = await scanSources({
        sourceFiles: [sourceFile('a.html', 'html')],
        adapters,
        readFile: filesystem({ '/repo/a.html': 'other.png' }),
        assetBasenames: new Set(['hero.png']),
      });

      expect(result.mentions).toEqual([]);
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

    expect(result).toEqual({ references: [], unscanned: [], mentions: [] });
  });
});
