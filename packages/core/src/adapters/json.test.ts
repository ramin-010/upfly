import { describe, expect, it } from 'vitest';
import type { RawReference } from '../types.js';
import { jsonAdapter } from './json.js';

function find(text: string, file = '/project/manifest.json'): RawReference[] {
  return jsonAdapter.findReferences({ file, text });
}

function paths(text: string): string[] {
  return find(text).map((reference) => reference.rawPath);
}

function slices(text: string): string[] {
  return find(text).map((reference) => text.slice(reference.start, reference.end));
}

describe('jsonAdapter', () => {
  it('claims the json extension', () => {
    expect(jsonAdapter.id).toBe('json');
    expect(jsonAdapter.extensions).toEqual(['.json']);
  });

  describe('emits every path-shaped value as a speculative candidate', () => {
    const cases: ReadonlyArray<[name: string, source: string, expected: readonly string[]]> = [
      ['a simple value', '{"icon": "./logo.png"}', ['./logo.png']],
      ['a root-relative path', '{"icon": "/images/logo.png"}', ['/images/logo.png']],
      ['a bare filename', '{"icon": "logo.png"}', ['logo.png']],
      ['a nested value', '{"a": {"b": {"icon": "./logo.png"}}}', ['./logo.png']],
      ['array entries', '{"icons": ["./a.png", "./b.png"]}', ['./a.png', './b.png']],
      ['an array at the root', '["./a.png", "./b.png"]', ['./a.png', './b.png']],
      ['a bare string document', '"./a.png"', ['./a.png']],
      [
        'several values across the document',
        '{"icon": "./a.png", "splash": "./b.jpg", "name": "app"}',
        ['./a.png', './b.jpg'],
      ],
      ['non-image extensions are still candidates', '{"main": "./index.js"}', ['./index.js']],
      ['pretty-printed input', '{\n  "icon": "./logo.png"\n}', ['./logo.png']],
    ];

    it.each(cases)('%s', (_name, source, expected) => {
      expect(paths(source)).toEqual([...expected]);
      expect(slices(source)).toEqual([...expected]);
    });

    it('marks every candidate as speculative, not asserted', () => {
      const [reference] = find('{"icon": "./logo.png"}');
      expect(reference?.asserted).toBe(false);
      expect(reference?.kind).toBe('json');
      expect(reference?.ceiling).toBe('high');
    });
  });

  describe('skips keys', () => {
    it('ignores a key that looks like a path', () => {
      expect(paths('{"./logo.png": "the logo"}')).toEqual([]);
    });

    it('ignores a key but keeps its value', () => {
      expect(paths('{"./key.png": "./value.png"}')).toEqual(['./value.png']);
    });

    it('ignores a key with whitespace before the colon', () => {
      expect(paths('{"./logo.png"   : 1}')).toEqual([]);
    });

    it('ignores a key across a newline before the colon', () => {
      expect(paths('{"./logo.png"\n: 1}')).toEqual([]);
    });

    it('treats a string at the end of the document as a value', () => {
      expect(paths('["./logo.png"]')).toEqual(['./logo.png']);
    });
  });

  describe('skips what cannot be a local asset path', () => {
    const cases: ReadonlyArray<[name: string, source: string]> = [
      ['strings with no extension', '{"name": "my-app", "id": "abc/def"}'],
      ['https URLs', '{"icon": "https://cdn.example.com/logo.png"}'],
      ['data URIs', '{"icon": "data:image/png;base64,AAAA"}'],
      ['protocol-relative URLs', '{"icon": "//cdn.example.com/logo.png"}'],
      ['fragments', '{"icon": "#logo"}'],
      ['empty strings', '{"icon": ""}'],
      ['numbers and booleans', '{"size": 512, "ok": true, "none": null}'],
    ];

    it.each(cases)('%s', (_name, source) => {
      expect(find(source)).toEqual([]);
    });

    it('skips a value containing an escape, which cannot be located exactly', () => {
      // A JSON escape makes the source text and the decoded value different
      // lengths. A speculative candidate is not worth an imprecise range.
      const source = '{"icon": "./a\\u002Db.png"}';
      expect(find(source)).toEqual([]);
    });
  });

  describe('realistic documents', () => {
    it('reads a web app manifest', () => {
      const source = JSON.stringify(
        {
          name: 'Example',
          short_name: 'Ex',
          start_url: '/',
          icons: [
            { src: '/icons/192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icons/512.png', sizes: '512x512', type: 'image/png' },
          ],
        },
        null,
        2,
      );
      expect(paths(source)).toEqual(['/icons/192.png', '/icons/512.png']);
      expect(slices(source)).toEqual(['/icons/192.png', '/icons/512.png']);
    });

    it('produces candidates from a package.json without asserting any of them', () => {
      const source = JSON.stringify({ name: 'app', main: './dist/index.js', version: '1.0.0' });
      const references = find(source);
      // A version string looks like it has an extension, so it becomes a candidate
      // too. That is the generosity working as intended rather than a bug: the
      // resolver drops it for not being an asset extension, and it costs one number
      // in a report. Being stingy here is what loses a real reference.
      expect(references.map((reference) => reference.rawPath)).toEqual([
        './dist/index.js',
        '1.0.0',
      ]);
      // None of them is asserted, so none can ever become a broken finding.
      expect(references.every((reference) => reference.asserted === false)).toBe(true);
    });
  });

  describe('query suffixes', () => {
    it('keeps the suffix outside the range', () => {
      const source = '{"icon": "./logo.png?v=2"}';
      expect(paths(source)).toEqual(['./logo.png']);
      expect(slices(source)).toEqual(['./logo.png']);
    });
  });

  describe('offsets are UTF-16 code units', () => {
    it('stays aligned after an emoji', () => {
      const source = '{"title": "Launch 🎉", "icon": "./logo.png"}';
      expect(slices(source)).toEqual(['./logo.png']);
    });

    it('handles a non-ASCII path', () => {
      const source = '{"icon": "./héro-café.png"}';
      expect(paths(source)).toEqual(['./héro-café.png']);
      expect(slices(source)).toEqual(['./héro-café.png']);
    });
  });

  describe('is pure and deterministic', () => {
    it('returns the same result for the same input', () => {
      const source = '{"a": "./a.png", "b": "./b.png"}';
      expect(find(source)).toEqual(find(source));
    });

    it('returns references sorted by position', () => {
      const source = '{"a": "./first.png", "b": "./second.png"}';
      const starts = find(source).map((reference) => reference.start);
      expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    });

    it('records the file it was given', () => {
      expect(find('{"a": "./a.png"}', '/project/site.webmanifest.json')[0]?.file).toBe(
        '/project/site.webmanifest.json',
      );
    });
  });

  describe('rewrite', () => {
    it('replaces a path in place', () => {
      const source = '{"icon": "./logo.png"}';
      const rewritten = jsonAdapter.rewrite({
        text: source,
        edits: find(source).map((reference) => ({
          start: reference.start,
          end: reference.end,
          replacement: './logo.webp',
        })),
      });
      expect(rewritten).toBe('{"icon": "./logo.webp"}');
    });

    it('is a no-op with no edits', () => {
      const source = '{"icon": "./logo.png"}';
      expect(jsonAdapter.rewrite({ text: source, edits: [] })).toBe(source);
    });
  });
});
