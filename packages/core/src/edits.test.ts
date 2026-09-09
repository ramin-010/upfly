import { describe, expect, it } from 'vitest';
import { applyEdits, validateEdits } from './edits.js';
import { UpflyError } from './errors.js';
import type { Edit } from './types.js';

const edit = (start: number, end: number, replacement: string): Edit => ({
  start,
  end,
  replacement,
});

describe('applyEdits', () => {
  it('returns the source untouched when there are no edits', () => {
    expect(applyEdits('<img src="a.png">', [])).toBe('<img src="a.png">');
  });

  it('replaces a single range', () => {
    const source = '<img src="hero.png">';
    const result = applyEdits(source, [edit(10, 18, 'hero.webp')]);
    expect(result).toBe('<img src="hero.webp">');
  });

  it('applies several edits without offsets drifting', () => {
    // Two replacements of different lengths: a naive left-to-right implementation
    // would corrupt the second range once the first changed the string length.
    const source = 'a.png and b.png';
    const result = applyEdits(source, [edit(0, 5, 'a.webp'), edit(10, 15, 'b.avif')]);
    expect(result).toBe('a.webp and b.avif');
  });

  it('is order-independent for the same set of edits', () => {
    const source = 'one.png two.png three.png';
    const edits = [edit(0, 7, '1.webp'), edit(8, 15, '2.webp'), edit(16, 25, '3.webp')];
    const forwards = applyEdits(source, edits);
    const backwards = applyEdits(source, [...edits].reverse());
    expect(forwards).toBe('1.webp 2.webp 3.webp');
    expect(backwards).toBe(forwards);
  });

  it('supports pure insertions with a zero-width range', () => {
    const source = '<img src="a.png">';
    // Offset 5 is the start of `src`, i.e. immediately after `<img `.
    const result = applyEdits(source, [edit(5, 5, 'width="100" ')]);
    expect(result).toBe('<img width="100" src="a.png">');
  });

  it('supports deletions with an empty replacement', () => {
    expect(applyEdits('keep DROP keep', [edit(5, 10, '')])).toBe('keep keep');
  });

  it('allows adjacent, non-overlapping edits', () => {
    expect(applyEdits('abcd', [edit(0, 2, 'X'), edit(2, 4, 'Y')])).toBe('XY');
  });

  it('handles edits at the very start and end of the source', () => {
    expect(applyEdits('abc', [edit(0, 1, 'A'), edit(2, 3, 'C')])).toBe('AbC');
  });

  it('keeps offsets aligned with non-ASCII text', () => {
    // Offsets are UTF-16 code units. An emoji is a surrogate pair (length 2), so
    // this would land in the wrong place if the implementation assumed bytes.
    const source = '// 🎨 theme\nimport logo from "./logo.png";';
    const start = source.indexOf('./logo.png');
    const result = applyEdits(source, [edit(start, start + './logo.png'.length, './logo.webp')]);
    expect(result).toBe('// 🎨 theme\nimport logo from "./logo.webp";');
  });

  it('does not mutate the edits it is given', () => {
    const edits = [edit(4, 9, 'b.webp'), edit(0, 3, 'x')];
    const snapshot = structuredClone(edits);
    applyEdits('abc d.png', edits);
    expect(edits).toEqual(snapshot);
  });

  describe('rejects anything ambiguous rather than guessing', () => {
    it('throws on overlapping edits', () => {
      expect(() => applyEdits('abcdef', [edit(0, 4, 'x'), edit(2, 6, 'y')])).toThrow(UpflyError);
      expect(() => applyEdits('abcdef', [edit(0, 4, 'x'), edit(2, 6, 'y')])).toThrow(/overlaps/i);
    });

    it('throws when two edits start at the same offset', () => {
      // Order would decide the outcome, so there is no correct answer to pick.
      try {
        applyEdits('abcdef', [edit(2, 2, 'x'), edit(2, 4, 'y')]);
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(UpflyError);
        expect((error as UpflyError).code).toBe('AMBIGUOUS_EDITS');
      }
    });

    it('throws when a range runs past the end of the source', () => {
      try {
        applyEdits('abc', [edit(1, 99, 'x')]);
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as UpflyError).code).toBe('INVALID_EDIT_RANGE');
      }
    });

    it('throws on a negative or inverted range', () => {
      expect(() => applyEdits('abc', [edit(-1, 2, 'x')])).toThrow(UpflyError);
      expect(() => applyEdits('abc', [edit(2, 1, 'x')])).toThrow(UpflyError);
    });

    it('throws on non-integer offsets', () => {
      try {
        applyEdits('abc', [edit(0.5, 2, 'x')]);
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as UpflyError).code).toBe('INVALID_EDIT_RANGE');
      }
    });
  });
});

describe('validateEdits', () => {
  it('returns the edits sorted ascending by start', () => {
    const ordered = validateEdits('abcdefghij', [
      edit(6, 8, 'z'),
      edit(0, 2, 'x'),
      edit(3, 5, 'y'),
    ]);
    expect(ordered.map((e) => e.start)).toEqual([0, 3, 6]);
  });

  it('accepts an empty edit list', () => {
    expect(validateEdits('abc', [])).toEqual([]);
  });

  it('surfaces the same failures as applyEdits, before anything is written', () => {
    expect(() => validateEdits('abc', [edit(0, 2, 'x'), edit(1, 3, 'y')])).toThrow(UpflyError);
  });
});
