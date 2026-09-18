/**
 * The id list the parse pool reads must be the adapter list the engine runs.
 *
 * 🔴 **`DEFAULT_ADAPTER_IDS` is a hand-written copy of `defaultAdapters`' ids**, kept
 * separate so `scan.ts` can stay adapter-free — it owns error handling across every
 * adapter and is tested against an in-memory file map, and importing the adapter barrel to
 * read six strings would drag parse5, Babel and PostCSS into it.
 *
 * ⚠️ **A hand-written copy of a list drifts, and this one drifts SILENTLY.** `scan.ts`
 * refuses the pool when any supplied adapter id is not in that list, so a new adapter added
 * to `defaultAdapters` and forgotten here would put **every** scan back on the main thread
 * with `reason: 'custom-adapter'` — which reads as a slow day rather than as a bug, since
 * the answer stays correct and only the wall clock moves. That is precisely the failure
 * class this project keeps finding: a regression with no symptom anyone would investigate.
 *
 * Both directions are asserted, because either half alone lets the lists diverge.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_ADAPTER_IDS } from './default-adapter-ids.js';
import { defaultAdapters } from './default-adapters.js';

describe('the parse pool’s adapter list', () => {
  it('names exactly the adapters the engine ships with', () => {
    expect([...DEFAULT_ADAPTER_IDS].sort()).toEqual(
      defaultAdapters.map((adapter) => adapter.id).sort(),
    );
  });

  it('holds no id twice, so a duplicate cannot mask a missing one', () => {
    expect(new Set(DEFAULT_ADAPTER_IDS).size).toBe(DEFAULT_ADAPTER_IDS.length);
  });
});
