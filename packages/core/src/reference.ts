/**
 * The accessors every consumer of a `Reference` must use.
 *
 * They live in this small module rather than in the resolver, so that the graph builder,
 * the audit and the planner can ask "is this linked?" without importing the module that
 * decides it.
 */

import type { RawReference, Reference } from './types.js';

/**
 * Whether this reference points at one or more assets in the graph.
 *
 * Use this rather than comparing `resolution` by hand: two outcomes are linked, and
 * `ref.resolution === 'resolved'` compiles and silently skips every pattern reference.
 * See "Ask `isLinked`, never `resolution === 'resolved'`" in ARCHITECTURE.md.
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
 * The `switch` has a `never`-typed default, so a new outcome breaks the build here
 * rather than quietly returning an empty array and un-linking a whole category of
 * reference.
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

/**
 * The path a reference's text proves: `rawPath`, except for a `+` chain or a template
 * with a same-file constant written in, where it is `assembledPath`.
 *
 * Use this wherever the question is what path this is (a glob, a static extension, a
 * classification), and `rawPath` wherever it is where the text is. One accessor rather
 * than `?? rawPath` at each call site, so the rule cannot hold in some places and be
 * missed in others.
 */
export function provenPath(reference: RawReference): string {
  return reference.assembledPath ?? reference.rawPath;
}
