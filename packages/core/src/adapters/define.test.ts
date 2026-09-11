import { describe, expect, it } from 'vitest';
import { cssAdapter } from './css.js';
import { type AdapterDefinition, defineAdapter, rewriteByEdits } from './define.js';
import { htmlAdapter } from './html.js';
import { javascriptAdapter } from './javascript.js';
import { jsonAdapter } from './json.js';
import { markdownAdapter } from './markdown.js';

/** A definition with the two required members and nothing else. */
const bare: AdapterDefinition = {
  id: 'test',
  extensions: ['.test'],
  findReferences: () => [],
};

describe('defineAdapter (R37)', () => {
  it('supplies the shared rewrite when a definition omits one', () => {
    const adapter = defineAdapter(bare);

    // Expected value derived here, not by calling applyEdits: replacing [6, 11)
    // of 'hello world!' with 'there' is 'hello there!' by inspection.
    expect(
      adapter.rewrite({
        text: 'hello world!',
        edits: [{ start: 6, end: 11, replacement: 'there' }],
      }),
    ).toBe('hello there!');
  });

  it('keeps an adapter’s own rewrite when it supplies one', () => {
    const adapter = defineAdapter({ ...bare, rewrite: () => 'overridden' });

    expect(adapter.rewrite({ text: 'hello world!', edits: [] })).toBe('overridden');
  });

  it('still supplies the default when rewrite is present but undefined', () => {
    // The `{ default, ...definition }` spelling would hand back `undefined` here and
    // every consumer would crash on the write path.
    //
    // The cast is the point rather than a workaround: `exactOptionalPropertyTypes` is
    // on, so TypeScript already refuses this call and a TS adapter author cannot reach
    // the case. `upfly-core` is published, so a JavaScript consumer can, and this pins
    // the runtime behaviour the compiler is not there to guarantee.
    const adapter = defineAdapter({ ...bare, rewrite: undefined } as unknown as AdapterDefinition);

    expect(typeof adapter.rewrite).toBe('function');
    expect(adapter.rewrite({ text: 'abc', edits: [{ start: 0, end: 1, replacement: 'X' }] })).toBe(
      'Xbc',
    );
  });

  it('applies several edits without letting earlier offsets shift', () => {
    // Two replacements of different lengths. By inspection, 'a/one/b/two/c' with
    // [2,5)->'1' and [8,11)->'22' is 'a/1/b/22/c'.
    const text = 'a/one/b/two/c';
    expect(
      rewriteByEdits({
        text,
        edits: [
          { start: 2, end: 5, replacement: '1' },
          { start: 8, end: 11, replacement: '22' },
        ],
      }),
    ).toBe('a/1/b/22/c');
  });

  it('propagates the strictness of applyEdits rather than softening it', () => {
    expect(() =>
      rewriteByEdits({ text: 'abc', edits: [{ start: 0, end: 99, replacement: '' }] }),
    ).toThrow(/INVALID_EDIT_RANGE|not within a source/);
  });
});

describe('no adapter carries a private copy of rewrite (R37)', () => {
  // The assertion the ruling exists for. Five byte-identical copies drift; this
  // fails the moment one of them is reintroduced, which is what "the shape removes
  // the possibility" has to mean in practice.
  const adapters = [
    ['css', cssAdapter],
    ['html', htmlAdapter],
    ['javascript', javascriptAdapter],
    ['json', jsonAdapter],
    ['markdown', markdownAdapter],
  ] as const;

  for (const [name, adapter] of adapters) {
    it(`${name} uses the shared implementation`, () => {
      expect(adapter.rewrite).toBe(rewriteByEdits);
    });
  }

  it('would notice a private copy — the control', () => {
    // Proves the assertion above can fail: an adapter that supplies its own rewrite,
    // even one that behaves identically, is not the shared function.
    const drifted = defineAdapter({ ...bare, rewrite: rewriteByEdits.bind(null) });

    expect(drifted.rewrite).not.toBe(rewriteByEdits);
  });
});
