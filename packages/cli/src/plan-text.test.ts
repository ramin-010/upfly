import type { Manifest } from 'upfly-core';
import { describe, expect, it } from 'vitest';
import { count, movingText, writtenByKind } from './plan-text.js';

describe('writtenByKind', () => {
  it('sorts what a run wrote into created, changed and removed', () => {
    const manifest = {
      operations: [
        { kind: 'create', path: 'images/a.webp', staged: 'staged/images/a.webp', afterHash: 'x' },
        { kind: 'edit', path: 'index.html', beforeHash: 'b', afterHash: 'a', inverse: [] },
        { kind: 'delete', path: 'images/a.png', beforeHash: 'b', backup: 'backup/images/a.png' },
        { kind: 'move', from: 'old/c.png', to: 'new/c.png', hash: 'h' },
      ],
    } as unknown as Manifest;

    expect(writtenByKind(manifest)).toEqual({
      created: ['images/a.webp', 'new/c.png'],
      changed: ['index.html'],
      removed: ['images/a.png', 'old/c.png'],
    });
  });
});

describe('count', () => {
  it('agrees the noun with the number', () => {
    expect([count(0, 'file'), count(1, 'file'), count(2, 'file')]).toEqual([
      '0 files',
      '1 file',
      '2 files',
    ]);
  });
});

describe('movingText', () => {
  it('says whether all, none or some of the references move, in plain words', () => {
    expect(movingText(1, 1, 'to x')).toBe('its 1 reference moves to x');
    expect(movingText(3, 3, 'to x')).toBe('all 3 of its references move to x');
    expect(movingText(0, 1, 'to x')).toBe('its 1 reference stays as written');
    expect(movingText(0, 2, 'to x')).toBe('its 2 references stay as written');
    expect(movingText(1, 2, 'to x')).toBe('1 of its 2 references moves to x');
    expect(movingText(2, 3, 'to x')).toBe('2 of its 3 references move to x');
  });
});
