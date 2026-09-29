/**
 * `dedupe` over a project on disk: for each set of byte-identical images, keep one copy and
 * point every reference to another copy at it, where it can follow, through the same
 * transaction and manifest as `optimize`. Nothing is deleted: a copy no reference names any
 * more stays on disk, and the audit lists it as unused with its size.
 */

import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { compareStrings, relativePath } from './paths.js';
import {
  type PipelineOutput,
  type PipelineProgress,
  runPipeline,
  servingRootsFor,
} from './pipeline.js';
import { type PlannedRewrite, servingRootOf } from './plan/plan.js';
import { type RepointOutcome, planRepoint } from './plan/relocate.js';
import type { ServingRoots } from './resolve/resolve.js';
import { citeReferences } from './scan/citation.js';
import { createNodeFileStore } from './write/file-store-node.js';
import type { Manifest } from './write/manifest.js';
import { newRunId, writeRewrites } from './write/optimize.js';
import type { LockPorts } from './write/transaction.js';

export interface DedupeProjectInput {
  /** The project directory. */
  readonly root: string;
  /** The folders the project says it is served from. Absent, Upfly decides them. */
  readonly declared?: ServingRoots;
  /** Nothing is written unless this is true. */
  readonly apply: boolean;
  /** Copies to keep, POSIX paths relative to the project, each naming one copy of one set. */
  readonly keep?: readonly string[];
  /** More paths to leave out, in `.gitignore` syntax, on top of `.upflyignore`. */
  readonly extraIgnores?: readonly string[];
  readonly onProgress?: (event: PipelineProgress) => void;
  /** Called with the finished plan before anything is written; `false` writes nothing. */
  readonly beforeWrite?: (plan: DedupePlan) => boolean | Promise<boolean>;
  /** The run's id. A fresh one from the clock when absent. */
  readonly runId?: string;
  /** The clock the manifest's times come from. */
  readonly now?: () => string;
  readonly lock?: LockPorts;
}

/** Why a set's copy was kept. */
export type KeptBecause =
  /** The caller named it. */
  | 'chosen'
  /** More references use it than any other copy. */
  | 'most-used'
  /** As many references use it as another, and a folder the site is served from holds it. */
  | 'served'
  /** Tied on both, and its path is the shortest. */
  | 'shorter'
  /** Tied on all three, and it comes first in path order. */
  | 'first';

/** A reference to a copy that stays as written, and why. */
export interface StayingReference {
  /** POSIX-relative path of the file that holds it. */
  readonly file: string;
  /** One-based line, or `null` when the file could not be read again. */
  readonly line: number | null;
  /** `file:line`, or the file alone. */
  readonly where: string;
  /** The path as it is written. */
  readonly text: string;
  readonly why: string;
}

/** One copy that is not kept. */
export interface DedupeCopy {
  readonly path: string;
  /** References that name it today. */
  readonly references: number;
  /** How many of them the plan points at the kept copy. */
  readonly moved: number;
  readonly stays: readonly StayingReference[];
  /** True when no reference Upfly can read names it once the plan is written. It stays on disk. */
  readonly unusedAfter: boolean;
}

/** One set of identical images: the copy kept, why, and every other copy. */
export interface DedupeSet {
  readonly keep: string;
  readonly kept: KeptBecause;
  /** The size of one copy. */
  readonly bytes: number;
  /** Every copy but the kept one, in path order. */
  readonly copies: readonly DedupeCopy[];
}

export interface DedupePlan {
  readonly sets: readonly DedupeSet[];
  /** The edits, one entry per file, in path order. */
  readonly rewrites: readonly PlannedRewrite[];
}

export interface DedupeProjectResult {
  /** What the plan was made from. */
  readonly pipeline: PipelineOutput;
  readonly plan: DedupePlan;
  /** The record of the run, or `null` when nothing was written. */
  readonly manifest: Manifest | null;
}

/**
 * Plans keeping one copy of each set of identical images and, when `apply` is true, points
 * the references at it.
 *
 * @param input the project, the copies to keep, and whether to write
 * @returns the pipeline's output, the plan, and the run's record when it wrote
 * @throws {UpflyError} `TRANSACTION_LOCKED` when another run holds the project, and the
 * transaction's other codes when a file changed under the run
 */
export async function dedupeProject(input: DedupeProjectInput): Promise<DedupeProjectResult> {
  const pipeline = await runPipeline({
    root: input.root,
    servingRoots: servingRootsFor(input.declared),
    publicDirs: (servingRoots) => servingRoots.dirs,
    probeOptions: null,
    ...(input.extraIgnores === undefined ? {} : { extraIgnores: input.extraIgnores }),
    ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
  });
  const { graph, servingRoots, aliases } = pipeline;
  const duplicates = pipeline.audit.findings.flatMap((finding) =>
    finding.kind === 'duplicate' ? [finding] : [],
  );

  const uses = new Map(graph.assets.map((node) => [node.asset.relative, node.references.length]));
  const chosen = new Set(input.keep ?? []);
  const keeps = duplicates.map((set) => keepOf(set.assets, uses, chosen, servingRoots));
  const repointing = planRepoint({
    graph,
    servingRoots,
    aliases,
    repoints: duplicates.flatMap((set, index) =>
      set.assets
        .filter((path) => path !== keeps[index]?.path)
        .map((from) => ({ from, to: keeps[index]?.path ?? from })),
    ),
    listDirectory,
  });
  const staying = await cite(repointing.outcomes, graph.root);

  const plan: DedupePlan = {
    sets: duplicates.map((set, index) => {
      const keep = keeps[index] ?? { path: set.assets[0] ?? '', because: 'first' as const };
      return {
        keep: keep.path,
        kept: keep.because,
        bytes: set.bytes,
        copies: set.assets
          .filter((path) => path !== keep.path)
          .map((path) => {
            const outcomes = repointing.outcomes.filter((outcome) => outcome.repoint.from === path);
            const stays = outcomes.flatMap((outcome) => staying.get(outcome) ?? []);
            return {
              path,
              references: uses.get(path) ?? 0,
              moved: outcomes.length - stays.length,
              stays,
              unusedAfter: stays.length === 0,
            };
          }),
      };
    }),
    rewrites: repointing.rewrites,
  };

  if (!input.apply || plan.rewrites.length === 0) return { pipeline, plan, manifest: null };
  if (input.beforeWrite !== undefined && !(await input.beforeWrite(plan))) {
    return { pipeline, plan, manifest: null };
  }
  const manifest = await writeRewrites({
    rewrites: plan.rewrites,
    store: createNodeFileStore(pipeline.discovery.root),
    runId: input.runId ?? newRunId(new Date()),
    now: input.now ?? (() => new Date().toISOString()),
    declined: plan.sets.flatMap((set) =>
      set.copies.flatMap((copy) =>
        copy.stays.map((stay) => ({ path: stay.file, line: stay.line, reason: stay.why })),
      ),
    ),
    ...(input.lock === undefined ? {} : { lock: input.lock }),
  });
  return { pipeline, plan, manifest };
}

/**
 * The copy to keep: the one named, else the one most references use; on a tie, one a folder
 * the site is served from holds, then the shortest path, then the first in path order.
 */
function keepOf(
  assets: readonly string[],
  uses: ReadonlyMap<string, number>,
  chosen: ReadonlySet<string>,
  servingRoots: ServingRoots,
): { readonly path: string; readonly because: KeptBecause } {
  const named = assets.find((path) => chosen.has(path));
  if (named !== undefined) return { path: named, because: 'chosen' };
  const count = (path: string) => uses.get(path) ?? 0;
  const served = (path: string) => (servingRootOf(path, servingRoots) === null ? 0 : 1);
  const [first = '', second = ''] = [...assets].sort(
    (a, b) =>
      count(b) - count(a) || served(b) - served(a) || a.length - b.length || compareStrings(a, b),
  );
  const because: KeptBecause =
    count(first) > count(second)
      ? 'most-used'
      : served(first) > served(second)
        ? 'served'
        : first.length < second.length
          ? 'shorter'
          : 'first';
  return { path: first, because };
}

/** Each reference that stays as written, cited so a reviewer can open it. */
async function cite(
  outcomes: readonly RepointOutcome[],
  root: string,
): Promise<ReadonlyMap<RepointOutcome, StayingReference>> {
  const staying = outcomes.filter((outcome) => outcome.why !== undefined);
  const { citations } = await citeReferences({
    references: staying.map((outcome) => outcome.reference),
    root,
    readFile: (path) => readFile(path, 'utf8'),
  });
  return new Map(
    staying.map((outcome) => {
      const citation = citations.get(outcome.reference);
      const file = citation?.file ?? relativePath(root, outcome.reference.file);
      return [
        outcome,
        {
          file,
          line: citation?.line ?? null,
          where: citation?.where ?? file,
          text: outcome.reference.rawPath,
          why: outcome.why ?? '',
        },
      ];
    }),
  );
}

/**
 * The names in a directory, for the check on where a new path leads, which counts the files
 * an ignore rule kept out of the walk. Only names are read, never a file.
 */
function listDirectory(path: string): readonly string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}
