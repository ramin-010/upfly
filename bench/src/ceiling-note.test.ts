import { describe, expect, it } from 'vitest';
import { ceilingNote } from './ceiling-note.js';

describe('what the gate says when it measures over the ceiling', () => {
  it('says HEAD itself is over the ceiling when an unchanged tree measures over it locally', () => {
    const note = ceilingNote({ over: true, inCi: false, headUnchanged: true });

    expect(note).toContain('This gate cannot judge a change on this machine');
    expect(note).toContain('HEAD, unchanged, is over the ceiling');
    expect(note).toContain('A/B');
  });

  it('with changes in the tree, says how to tell whether HEAD alone is over it', () => {
    for (const headUnchanged of [false, undefined]) {
      const note = ceilingNote({ over: true, inCi: false, headUnchanged });

      expect(note).toContain('If HEAD, unchanged, is over the ceiling');
      expect(note).toContain('on a clean tree');
      expect(note).not.toContain('This gate cannot judge a change on this machine');
    }
  });

  it('says nothing in CI, whose runners the ceiling is set for, or within the ceiling', () => {
    expect(ceilingNote({ over: true, inCi: true, headUnchanged: true })).toBe('');
    expect(ceilingNote({ over: false, inCi: false, headUnchanged: true })).toBe('');
  });
});
