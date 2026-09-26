/**
 * One shared `rewrite`, so adapters cannot drift apart.
 *
 * `defineAdapter` fills in the default, and an adapter supplies its own `rewrite` only
 * when it has a reason to. The interface keeps `rewrite` for an adapter whose syntax
 * needs re-escaping when a path changes, such as a JSON string holding an escaped path
 * or a CSS `url()` that needs quotes it did not have before: a plain range replacement
 * cannot serve it.
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
 * The return type is a full `Adapter`, so no consumer sees an optional `rewrite` or needs
 * a fallback of its own.
 */
export function defineAdapter(definition: AdapterDefinition): Adapter {
  // `??` rather than spreading the default first: `{ rewrite: default, ...definition }`
  // is defeated by an explicit `rewrite: undefined`, which would hand every consumer a
  // missing rewrite on the write path. This form cannot be.
  return { ...definition, rewrite: definition.rewrite ?? rewriteByEdits };
}
