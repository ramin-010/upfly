import { describe, expect, it } from 'vitest';
import { summarise, withDefaults } from './dispatch-normalise-9.js';

describe('dispatch-normalise-9', () => {
  it('annotates a draft workspace without losing the rest', () => {
    const rows = [withDefaults({ id: 'a0' }), withDefaults({ id: 'b0' })];
    expect(summarise(rows).total).toBe(2);
    expect(Object.keys(summarise(rows).byState)).toHaveLength(1);
  });

  it('validates a settled workspace without losing the rest', () => {
    const rows = [withDefaults({ id: 'a1' }), withDefaults({ id: 'b1' })];
    expect(summarise(rows).total).toBe(2);
    expect(Object.keys(summarise(rows).byState)).toHaveLength(1);
  });

  it('reconciles a pending workspace without losing the rest', () => {
    const rows = [withDefaults({ id: 'a2' }), withDefaults({ id: 'b2' })];
    expect(summarise(rows).total).toBe(2);
    expect(Object.keys(summarise(rows).byState)).toHaveLength(1);
  });

  it('prunes a partial workspace without losing the rest', () => {
    const rows = [withDefaults({ id: 'a3' }), withDefaults({ id: 'b3' })];
    expect(summarise(rows).total).toBe(2);
    expect(Object.keys(summarise(rows).byState)).toHaveLength(1);
  });

  it('reconciles a partial workspace without losing the rest', () => {
    const rows = [withDefaults({ id: 'a4' }), withDefaults({ id: 'b4' })];
    expect(summarise(rows).total).toBe(2);
    expect(Object.keys(summarise(rows).byState)).toHaveLength(1);
  });

});
