/**
 * The two accessors every consumer of a `Reference` must use.
 *
 * They live here, beside the types, rather than in the resolver, so that the graph
 * builder, the audit and the planner can ask "is this linked?" without importing the
 * module that decides it.
 */

import type { Reference } from './types.js';

/**
 * Whether this reference points at one or more assets in the graph.
 *
 * **Use this instead of comparing `resolution` by hand.** There are two linked
 * outcomes, not one, and `if (ref.resolution === 'resolved')` compiles fine, runs
 * fine, and silently ignores every pattern reference — a false negative the compiler
 * cannot see, which is exactly the class §5.1(b) exists to catch.
 */
export function isLinked(
  reference: Reference,
): reference is Extract<Reference, { resolution: 'resolved' | 'resolved-pattern' }> {
  return reference.resolution === 'resolved' || reference.resolution === 'resolved-pattern';
}

/**
 * Every asset this reference points at: one for `resolved`, one or more for
 * `resolved-pattern`, none for anything else.
 *
 * The `switch` is exhaustive against a `never`-typed default on purpose. Adding a
 * seventh outcome later must break the build here rather than quietly returning an
 * empty array and un-linking a whole category of reference.
 */
export function linkedPaths(reference: Reference): readonly string[] {
  switch (reference.resolution) {
    case 'resolved':
      return [reference.resolvedPath];
    case 'resolved-pattern':
      return reference.resolvedPaths;
    case 'out-of-scope':
    // Deliberately not linked: the target exists but is not in the asset set, so it
    // is neither rewritten nor capable of being a dead asset.
    case 'dynamic':
    case 'broken':
    case 'discarded':
    case 'unresolved-alias':
      return [];
    default: {
      const unhandled: never = reference;
      return unhandled;
    }
  }
}
