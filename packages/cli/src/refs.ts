/**
 * `upfly refs <image>`: every reference to one image, whether `optimize` could rewrite each,
 * and what it would do with the image. The whole project is read, since a reference can sit
 * in any file; only that image is measured. Nothing is written.
 */

import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { type EncodeFormat, type OptimizeProjectResult, optimizeProject } from 'upfly-core';
import {
  type AssetNode,
  type LinkedReference,
  citeReferences,
  formatBytes,
  isLinked,
  relativePath,
  whyReferenceStays,
} from 'upfly-core/internal';
import type { RefsOptions } from './args.js';
import { isDirectory } from './audit.js';
import { loadConfig } from './config.js';
import { EXIT_CODES, type ExitCode } from './exit-codes.js';
import { headline, spaced } from './layout.js';
import { policyFor } from './optimize.js';
import { type Io, type Styles, emit, progressReporter, stopWith, stylesFor } from './output.js';
import { movingText } from './plan-text.js';

/** One reference to the image: where it is, what it says, and whether a run could move it. */
export interface ReferenceAnswer {
  /** POSIX-relative path of the file that holds it. */
  readonly file: string;
  /** One-based line, or `null` when the file could not be read again. */
  readonly line: number | null;
  /** The path as it is written. */
  readonly text: string;
  readonly rewritable: boolean;
  /** Why it stays as written, when it does. */
  readonly why?: string;
}

/** What `optimize` would do with the image, with the configured format and policy. */
export type Verdict =
  | {
      readonly kind: 'converts';
      readonly to: string;
      readonly savedBytes: number;
      readonly removesOriginal: boolean;
    }
  | { readonly kind: 'not-converted'; readonly why: string }
  | { readonly kind: 'unused' }
  | {
      readonly kind: 'possibly-unused';
      readonly mentions: readonly { readonly where: string; readonly quote: string }[];
    };

/**
 * Answers for one image.
 *
 * @param options the parsed command line
 * @param io the streams and environment to use
 * @returns 0 with the answer; 2 when the image is missing, outside the project or not an
 * image Upfly found; 3 when the configuration file belongs to another tool
 */
export async function runRefs(options: RefsOptions, io: Io): Promise<ExitCode> {
  const root = resolve(options.dir);
  if (!isDirectory(root)) {
    return stopWith(io, options, EXIT_CODES.USAGE, `${options.dir} is not a directory`);
  }
  const config = await loadConfig(root);
  if (config.kind === 'refused') {
    return stopWith(io, options, EXIT_CODES.ABORTED, config.message, config.reason);
  }
  if (config.kind === 'invalid') {
    return stopWith(io, options, EXIT_CODES.USAGE, `${config.file} ${config.message}`);
  }
  const settings = config.kind === 'loaded' ? config.config : {};

  const image = resolve(options.image);
  const within = relative(root, image);
  if (within === '' || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
    return stopWith(
      io,
      options,
      EXIT_CODES.USAGE,
      `${options.image} is outside the project at ${root}. Name an image inside it, or name its project after it: upfly refs <image> <folder>.`,
    );
  }
  if (!isFile(image)) {
    return stopWith(io, options, EXIT_CODES.USAGE, `there is no file at ${options.image}.`);
  }
  const path = within.split(sep).join('/');
  const format = settings.format ?? 'webp';

  const publicDirs = options.publicDirs ?? settings.publicDirs ?? null;
  const progress = progressReporter(io, 'refs', options.json);
  const result = await optimizeProject({
    root,
    ...(publicDirs === null ? {} : { declared: { dirs: publicDirs, declared: true } }),
    format,
    publicPolicy: policyFor({ policy: null }, settings),
    apply: false,
    extraIgnores: [...(settings.exclude ?? []), ...options.exclude],
    only: { paths: [path] },
    onProgress: (event) => progress.update(event),
  });
  progress.clear();

  const node = result.pipeline.graph.assets.find((candidate) => candidate.asset.relative === path);
  if (node === undefined) {
    return stopWith(
      io,
      options,
      EXIT_CODES.USAGE,
      `${path} is not an image Upfly found in the project: its extension is not an image's, or the walk leaves it out (.upflyignore, --exclude, or a folder Upfly always skips, such as node_modules).`,
    );
  }

  const references = await answersFor(node, result, format);
  const verdict = verdictFor(node, result, format);
  if (options.json) {
    emit(io, {
      type: 'result',
      command: 'refs',
      exitCode: EXIT_CODES.OK,
      image: path,
      bytes: node.asset.bytes,
      references,
      verdict,
    });
  } else {
    const styles = stylesFor(io.stdout, io.env, options);
    io.stdout.write(spaced(render(node, references, verdict, styles).split('\n')));
  }
  return EXIT_CODES.OK;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Each reference, cited, with the planner's own answer to whether it could move. */
async function answersFor(
  node: AssetNode,
  result: OptimizeProjectResult,
  format: EncodeFormat,
): Promise<ReferenceAnswer[]> {
  const { graph, servingRoots, builds } = result.pipeline;
  const linked = node.references.filter(isLinked) as LinkedReference[];
  const { citations } = await citeReferences({
    references: linked,
    root: graph.root,
    readFile: (file) => readFile(file, 'utf8'),
  });
  return linked.map((reference) => {
    const citation = citations.get(reference);
    const why = whyReferenceStays(reference, { graph, servingRoots, format, builds });
    return {
      file: citation?.file ?? relativePath(graph.root, reference.file),
      line: citation?.line ?? null,
      text: reference.rawPath,
      rewritable: why === null,
      ...(why === null ? {} : { why }),
    };
  });
}

function verdictFor(node: AssetNode, result: OptimizeProjectResult, format: EncodeFormat): Verdict {
  const path = node.asset.relative;
  if (node.references.length === 0) {
    const hedged = result.pipeline.audit.findings.find(
      (finding) => finding.kind === 'possibly-dead' && finding.asset === path,
    );
    return hedged?.kind === 'possibly-dead'
      ? {
          kind: 'possibly-unused',
          mentions: hedged.evidence.map(({ where, quote }) => ({ where, quote })),
        }
      : { kind: 'unused' };
  }
  const { plan, refusal } = result.optimize;
  if (refusal !== null) return { kind: 'not-converted', why: refusal.reason.replace(/\.$/, '') };
  const conversion = plan.conversions.find((planned) => planned.asset === path);
  if (conversion !== undefined) {
    return {
      kind: 'converts',
      to: conversion.target,
      savedBytes: conversion.savedBytes,
      removesOriginal: conversion.replacesOriginal,
    };
  }
  const declined = plan.declined.find((entry) => entry.path === path);
  if (declined !== undefined) return { kind: 'not-converted', why: declined.reason };
  return { kind: 'not-converted', why: unmeasuredWhy(node, result, format) };
}

/** Why an image the plan neither converted nor declined stays: it could not be measured. */
function unmeasuredWhy(
  node: AssetNode,
  result: OptimizeProjectResult,
  format: EncodeFormat,
): string {
  const name = format === 'avif' ? 'AVIF' : 'WebP';
  if (node.asset.extension === `.${format}`) return `it is already a ${name}`;
  const probe = result.pipeline.probes?.find((entry) => entry.relative === node.asset.relative);
  const skipped = probe?.skipped[0];
  return skipped === undefined
    ? `Upfly could not measure it as ${name}, and converts only on a measured saving`
    : `it was not measured as ${name}: ${skipped.reason}`;
}

function render(
  node: AssetNode,
  references: readonly ReferenceAnswer[],
  verdict: Verdict,
  styles: Styles,
): string {
  const cited = references.flatMap((reference) => [
    `    ${reference.line === null ? reference.file : `${reference.file}:${reference.line}`}  ${reference.text}`,
    ...(reference.why === undefined ? [] : [`      stays as written: ${reference.why}`]),
  ]);
  return [
    headline(styles, 'refs'),
    '',
    `${node.asset.relative}  ${formatBytes(node.asset.bytes)}`,
    '',
    ...(references.length === 0
      ? ['No reference Upfly can read reaches it.']
      : [styles.accent(`References (${references.length})`), ...cited]),
    '',
    `${styles.accent('Verdict:')} ${verdictText(node, references, verdict)}`,
    '',
  ].join('\n');
}

function verdictText(
  node: AssetNode,
  references: readonly ReferenceAnswer[],
  verdict: Verdict,
): string {
  switch (verdict.kind) {
    case 'converts': {
      const moving = references.filter((reference) => reference.rewritable).length;
      const after = formatBytes(node.asset.bytes - verdict.savedBytes);
      const original = verdict.removesOriginal
        ? 'the original is removed, since every reference to it moves'
        : 'the original stays beside it';
      return `converts to ${verdict.to}, ${formatBytes(node.asset.bytes)} to ${after}. ${capitalise(movingText(moving, references.length, 'to the new file'))}; ${original}.`;
    }
    case 'not-converted':
      return `not converted: ${verdict.why}.`;
    case 'unused':
      return 'unused. Nothing names it, not even by file name in a file Upfly could not read; Upfly never deletes an image that nothing uses, and `upfly audit` lists it with its size.';
    case 'possibly-unused':
      return `possibly unused. No reference Upfly can follow reaches it, but its name appears in ${verdict.mentions.map((mention) => mention.where).join(', ')}.`;
  }
}

function capitalise(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}
