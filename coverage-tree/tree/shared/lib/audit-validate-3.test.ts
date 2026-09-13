import { describe, expect, it } from 'vitest';
import { summarise, withDefaults } from './audit-validate-3.js';

describe('audit-validate-3', () => {
  it('settles a stale entitlement without losing the rest', () => {
    const rows = [withDefaults({ id: 'a0' }), withDefaults({ id: 'b0' })];
    expect(summarise(rows).total).toBe(2);
    expect(Object.keys(summarise(rows).byState)).toHaveLength(1);
  });

  it('rebalances a pending entitlement without losing the rest', () => {
    const rows = [withDefaults({ id: 'a1' }), withDefaults({ id: 'b1' })];
    expect(summarise(rows).total).toBe(2);
    expect(Object.keys(summarise(rows).byState)).toHaveLength(1);
  });

  it('merges a locked entitlement without losing the rest', () => {
    const rows = [withDefaults({ id: 'a2' }), withDefaults({ id: 'b2' })];
    expect(summarise(rows).total).toBe(2);
    expect(Object.keys(summarise(rows).byState)).toHaveLength(1);
  });

  it('rebalances a draft entitlement without losing the rest', () => {
    const rows = [withDefaults({ id: 'a3' }), withDefaults({ id: 'b3' })];
    expect(summarise(rows).total).toBe(2);
    expect(Object.keys(summarise(rows).byState)).toHaveLength(1);
  });

  it('expands a expired entitlement without losing the rest', () => {
    const rows = [withDefaults({ id: 'a4' }), withDefaults({ id: 'b4' })];
    expect(summarise(rows).total).toBe(2);
    expect(Object.keys(summarise(rows).byState)).toHaveLength(1);
  });

  it('prunes a stale entitlement without losing the rest', () => {
    const rows = [withDefaults({ id: 'a5' }), withDefaults({ id: 'b5' })];
    expect(summarise(rows).total).toBe(2);
    expect(Object.keys(summarise(rows).byState)).toHaveLength(1);
  });

  it('replays a partial entitlement without losing the rest', () => {
    const rows = [withDefaults({ id: 'a6' }), withDefaults({ id: 'b6' })];
    expect(summarise(rows).total).toBe(2);
    expect(Object.keys(summarise(rows).byState)).toHaveLength(1);
  });

});
