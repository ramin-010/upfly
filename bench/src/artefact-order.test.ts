import { compareStrings } from 'upfly-core/internal';
import { describe, expect, it, vi } from 'vitest';
import { byFileLineAsset, byGroupSize } from './artefact-order.js';
import type { Triaged } from './triage.js';

describe('the order the validation artefacts are written in', () => {
  // `a`, `B`, `z` and a-umlaut sort one way under English rules, another under Swedish, and
  // a third way by code unit, the one order every machine agrees on.
  const names = ['a', 'B', 'z', String.fromCodePoint(0xe4)];
  const codeUnitOrder = [...names].sort(compareStrings);
  const english = new Intl.Collator('en');
  const swedish = new Intl.Collator('sv', { caseFirst: 'upper' });

  /** `items` sorted with every `localeCompare` call decided by `collator`. */
  function sortedUnder<T>(
    collator: Intl.Collator,
    items: readonly T[],
    compare: (a: T, b: T) => number,
  ) {
    const spy = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(function (
      this: unknown,
      that: string,
    ) {
      return collator.compare(String(this), that);
    });
    try {
      return [...items].sort(compare);
    } finally {
      spy.mockRestore();
    }
  }

  it('writes the unaccounted hits in code-unit order, whichever locale the machine sorts in', () => {
    const hits = names.map(
      (name) => ({ file: `${name}.md`, line: 1, asset: `img/${name}.png` }) as unknown as Triaged,
    );

    for (const collator of [english, swedish]) {
      const files = sortedUnder(collator, hits, byFileLineAsset).map((hit) => hit.file);
      expect(files).toEqual(codeUnitOrder.map((name) => `${name}.md`));
    }
  });

  it('writes the residue groups in code-unit order after their size, whichever locale', () => {
    const groups = names.map((name) => ({ label: name, entries: [] }));

    for (const collator of [english, swedish]) {
      const labels = sortedUnder(collator, groups, byGroupSize).map((group) => group.label);
      expect(labels).toEqual(codeUnitOrder);
    }
  });
});
