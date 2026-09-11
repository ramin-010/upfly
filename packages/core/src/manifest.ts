/**
 * The record of what a run intends to do, and the only thing `undo` reads.
 *
 * See ARCHITECTURE.md, "The transaction", for why the manifest is written before
 * the first file is touched rather than after the last.
 */

import type { Edit } from './types.js';

/** Bumped on any change a reader could trip over. Snapshot-tested as public API. */
export const MANIFEST_SCHEMA_VERSION = 1;

/** Where the manifest lives, relative to the project root. */
export const MANIFEST_PATH = '.upfly/manifest.json';

/**
 * Put a file at a path that does not exist yet.
 *
 * The bytes are already on disk under the run directory, so committing this is a
 * rename rather than an encode. Nothing is computed during commit that could fail
 * in a way we had not already seen during prepare.
 */
export interface CreateOperation {
  readonly kind: 'create';
  /** POSIX-relative to the project root. */
  readonly path: string;
  /** POSIX-relative to the run directory. */
  readonly staged: string;
  readonly afterHash: string;
}

/**
 * Replace the text of a file that already exists.
 *
 * `inverse` is the set of edits that turns the new text back into the old text.
 * Storing it rather than a copy of the whole file keeps the manifest self-contained:
 * one JSON file is the complete undo record, and the replaced text is a path string,
 * so the cost is bytes rather than kilobytes.
 */
export interface EditOperation {
  readonly kind: 'edit';
  readonly path: string;
  readonly beforeHash: string;
  readonly afterHash: string;
  readonly inverse: readonly Edit[];
}

/**
 * An asset's path changed.
 *
 * Committed as a copy in the create phase and a removal in the delete phase, so that
 * between the two both paths exist and any references pointing either way still
 * resolve. That is what lets an interrupted run leave a tree that still builds.
 * Undo needs no stored bytes because the bytes are still at the destination.
 */
export interface MoveOperation {
  readonly kind: 'move';
  readonly from: string;
  readonly to: string;
  /** The same on both sides; a move never rewrites content. */
  readonly hash: string;
}

/**
 * Remove a file.
 *
 * `backup` is mandatory in the type because a delete is the only operation whose
 * bytes cannot be reconstructed from anything else in the manifest. Prepare also
 * checks the backup file is really there, since a field can be filled in with a path
 * that was never written.
 */
export interface DeleteOperation {
  readonly kind: 'delete';
  readonly path: string;
  readonly beforeHash: string;
  /** POSIX-relative to the run directory. */
  readonly backup: string;
}

export type Operation = CreateOperation | EditOperation | MoveOperation | DeleteOperation;

/** Something the run chose not to do, and why. Never an empty explanation. */
export interface Declined {
  readonly path: string;
  readonly reason: string;
}

/**
 * `pending` is written before anything is touched and means "these operations may or
 * may not have happened". `committed` means every operation finished. A manifest
 * found in `pending` state on a later run is an interrupted run to recover from.
 */
export type ManifestState = 'pending' | 'committed';

export interface Manifest {
  readonly schemaVersion: number;
  readonly runId: string;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly state: ManifestState;
  /**
   * Run directory, POSIX-relative to the project root.
   *
   * Relative rather than absolute so a manifest means the same thing after the
   * project is moved or checked out elsewhere. No absolute path appears anywhere in
   * this schema for the same reason.
   */
  readonly runDir: string;
  readonly operations: readonly Operation[];
  readonly declined: readonly Declined[];
}

/**
 * Fields that legitimately differ between two runs over identical inputs.
 *
 * Everything not named here must be byte-identical across runs, and
 * `compareIgnoringVolatile` is what enforces it. The point of naming them rather
 * than normalising ad hoc in each test is that a new field which happens to vary
 * will fail the comparison instead of being quietly added to a normaliser.
 */
export const MANIFEST_VOLATILE_FIELDS = ['runId', 'startedAt', 'completedAt', 'runDir'] as const;

export type ManifestVolatileField = (typeof MANIFEST_VOLATILE_FIELDS)[number];

/**
 * Replace every volatile field with a fixed placeholder, leaving the rest untouched.
 *
 * Throws when a named field is missing from the manifest, because an allow-list
 * entry that covers nothing is worse than no entry: it reads as though a field is
 * being accounted for when the field it names has been renamed away.
 */
export function withoutVolatileFields(manifest: Manifest): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...manifest };

  for (const field of MANIFEST_VOLATILE_FIELDS) {
    if (!(field in copy)) {
      throw new Error(
        `Manifest has no field "${field}", but it is listed as volatile. Either the field was renamed and the list was not updated, or the list names something that never existed.`,
      );
    }
    copy[field] = `<${field}>`;
  }
  return copy;
}

/** Serialise deterministically: two runs over identical inputs produce identical bytes. */
export function serialiseManifest(manifest: Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function parseManifest(text: string): Manifest {
  return JSON.parse(text) as Manifest;
}
