/**
 * The adapters the engine ships with, as one list.
 *
 * ⚠️ **This exists because the list was assembled by hand in twelve places** — three
 * in `bench/`, the rest across the test suite — and adding a sixth adapter meant
 * finding all twelve. Miss one and that caller simply does not read the new file
 * type: no error, no failing test, just a category of reference silently absent from
 * whatever that caller measures. That is the dominant defect class in this codebase
 * — a mechanism that never fires — and it is worse here than for `rewrite`, because a
 * missing adapter makes assets look **dead** rather than making an edit wrong.
 *
 * Same move as `isLinked` and `defineAdapter`: one definition, so the possibility of
 * disagreement is removed rather than managed.
 *
 * **Order is not significant** — `discover` maps extension to adapter and no two
 * adapters claim the same extension — but it is kept stable so a caller iterating the
 * list produces deterministic output (rule 11).
 */

import type { Adapter } from '../types.js';
import { astroAdapter } from './astro.js';
import { cssAdapter } from './css.js';
import { htmlAdapter } from './html.js';
import { javascriptAdapter } from './javascript.js';
import { jsonAdapter } from './json.js';
import { markdownAdapter } from './markdown.js';

/**
 * Every adapter, in a stable order.
 *
 * A caller that wants a subset should filter this rather than rebuild it, so that a
 * new adapter reaches it by default and an omission is a visible decision.
 */
export const defaultAdapters: readonly Adapter[] = [
  astroAdapter,
  cssAdapter,
  htmlAdapter,
  javascriptAdapter,
  jsonAdapter,
  markdownAdapter,
];
