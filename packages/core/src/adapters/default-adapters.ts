/**
 * The adapters the engine ships with, as one list.
 *
 * Callers that want every adapter take the list from here, so a new adapter reaches all of
 * them. A caller that built its own list would silently not read the new file type: no
 * error, no failing test, and assets referenced only from that type would look dead.
 *
 * Order is not significant, since `discover` rejects two adapters claiming one extension,
 * but it is kept stable so that the same input always produces a byte-identical report.
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
