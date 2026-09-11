/**
 * One shared `rewrite`, so five adapters cannot drift apart.
 *
 * Every adapter's `rewrite` was `return applyEdits(text, edits)` — byte-identical in
 * all five files. Five identical copies are not neutral: they drift, and the one that
 * drifts silently here is the rewrite path, in the phase that writes to a user's
 * source files.
 *
 * ⚠️ **The interface keeps `rewrite`, and that is deliberate (R37).** Five identical
 * samples cannot prove a seam unnecessary — that is *"when every fixture has the same
 * value for the thing under test, the fixtures cannot test it"* pointed at an API —
 * and the future case is concrete: an adapter whose syntax needs **re-escaping** when
 * a path changes (a JSON string holding an escaped path, a CSS `url()` that needs
 * quotes it did not have before) cannot be served by a raw range replacement.
 *
 * So the seam stays and the duplication goes: `defineAdapter` fills in the default,
 * and an adapter supplies its own `rewrite` only when it has a reason to. The shape
 * removes the possibility of drift rather than asking five files to stay in step —
 * the same move as `isLinked()`.
 */

import { applyEdits } from '../edits.js';
import type { Adapter, Edit } from '../types.js';

/**
 * The default rewrite: pure, range-based, and strict about anything ambiguous.
 *
 * Exported in its own right so a custom `rewrite` can delegate to it after doing
 * whatever escaping its syntax needs, rather than reimplementing edit application.
 */
export function rewriteByEdits(input: {
  readonly text: string;
  readonly edits: readonly Edit[];
}): string {
  return applyEdits(input.text, input.edits);
}

/** An adapter as its module writes it: `rewrite` optional, everything else required. */
export type AdapterDefinition = Omit<Adapter, 'rewrite'> & Partial<Pick<Adapter, 'rewrite'>>;

/**
 * Complete an adapter definition, supplying `rewriteByEdits` unless one is given.
 *
 * The return type is a full `Adapter`, so no consumer ever sees an optional
 * `rewrite` and nobody downstream needs a `?? defaultRewrite` fallback — which would
 * be the same "ask every caller to remember" pattern in a new place.
 */
export function defineAdapter(definition: AdapterDefinition): Adapter {
  // `??` rather than spreading the default first: `{ rewrite: default, ...definition }`
  // is defeated by an explicit `rewrite: undefined`, which would hand every consumer a
  // missing rewrite on the write path. This form cannot be.
  return { ...definition, rewrite: definition.rewrite ?? rewriteByEdits };
}
