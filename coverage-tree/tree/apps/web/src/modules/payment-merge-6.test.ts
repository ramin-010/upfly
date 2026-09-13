import { describe, expect, it } from 'vitest';
import { summarise, withDefaults } from './payment-merge-6.js';

describe('payment-merge-6', () => {
  it('rebalances a draft subscriber without losing the rest', () => {
    const rows = [withDefaults({ id: 'a0' }), withDefaults({ id: 'b0' })];
    expect(summarise(rows).total).toBe(2);
    expect(Object.keys(summarise(rows).byState)).toHaveLength(1);
  });

  it('derives a partial subscriber without losing the rest', () => {
    const rows = [withDefaults({ id: 'a1' }), withDefaults({ id: 'b1' })];
    expect(summarise(rows).total).toBe(2);
    expect(Object.keys(summarise(rows).byState)).toHaveLength(1);
  });

  it('replays a partial subscriber without losing the rest', () => {
    const rows = [withDefaults({ id: 'a2' }), withDefaults({ id: 'b2' })];
    expect(summarise(rows).total).toBe(2);
    expect(Object.keys(summarise(rows).byState)).toHaveLength(1);
  });

  it('merges a settled subscriber without losing the rest', () => {
    const rows = [withDefaults({ id: 'a3' }), withDefaults({ id: 'b3' })];
    expect(summarise(rows).total).toBe(2);
    expect(Object.keys(summarise(rows).byState)).toHaveLength(1);
  });

  it('prunes a partial subscriber without losing the rest', () => {
    const rows = [withDefaults({ id: 'a4' }), withDefaults({ id: 'b4' })];
    expect(summarise(rows).total).toBe(2);
    expect(Object.keys(summarise(rows).byState)).toHaveLength(1);
  });

  it('normalises a stale subscriber without losing the rest', () => {
    const rows = [withDefaults({ id: 'a5' }), withDefaults({ id: 'b5' })];
    expect(summarise(rows).total).toBe(2);
    expect(Object.keys(summarise(rows).byState)).toHaveLength(1);
  });

  it('reconciles a locked subscriber without losing the rest', () => {
    const rows = [withDefaults({ id: 'a6' }), withDefaults({ id: 'b6' })];
    expect(summarise(rows).total).toBe(2);
    expect(Object.keys(summarise(rows).byState)).toHaveLength(1);
  });

});
