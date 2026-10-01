/**
 * `upfly audit`: a summary of the report, with the full report kept in Upfly's own folder.
 * No project file is written.
 */

import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type PipelineOutput,
  type Report,
  buildReport,
  renderReport,
  runPipeline,
  servingRootsFor,
} from 'upfly-core';
import type { AuditOptions } from './args.js';
import { loadConfig } from './config.js';
import { EXIT_CODES, type ExitCode } from './exit-codes.js';
import { renderSummary } from './layout.js';
import { type Io, colourFor, emit, progressReporter, stopWith, stylesFor } from './output.js';
import { warnIfNotKept, writeReport } from './report-file.js';
import { type NextStep, auditSummary } from './summary.js';

/**
 * Reads the project and prints what it found.
 *
 * @param options the parsed command line
 * @param io the streams and environment to use
 * @returns 0 when the audit ran; 2 or 3 when the configuration stopped it
 */
export async function runAudit(options: AuditOptions, io: Io): Promise<ExitCode> {
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
  const publicDirs = options.publicDirs ?? settings.publicDirs ?? null;

  const progress = progressReporter(io, 'audit', options.json);
  const output = await runPipeline({
    root,
    servingRoots: servingRootsFor(
      publicDirs === null ? undefined : { dirs: publicDirs, declared: true },
    ),
    publicDirs: (servingRoots) => servingRoots.dirs,
    probeOptions: probeOptionsFor(options, settings.format ?? 'webp'),
    extraIgnores: [...(settings.exclude ?? []), ...options.exclude],
    onProgress: (event) => progress.update(event),
  });
  progress.clear();

  const report = buildReport({
    graph: output.graph,
    audit: output.audit,
    discovery: output.discovery,
    sweep: output.sweep,
    servingRoots: output.servingRoots,
    aliases: output.aliases,
    ...(output.probes === undefined ? {} : { probes: output.probes }),
    includeDiscarded: options.includeDiscarded,
    includeUnusedVectors: options.includeUnusedSvg,
  });
  write(options, io, report, output, root);
  return EXIT_CODES.OK;
}

function probeOptionsFor(options: AuditOptions, format: 'webp' | 'avif') {
  if (!options.probe) return null;
  return {
    formats: [format],
    ...(options.maxEncodes === null ? {} : { maxEncodedAssets: options.maxEncodes }),
  };
}

function write(
  options: AuditOptions,
  io: Io,
  report: Report,
  output: PipelineOutput,
  root: string,
): void {
  if (options.json) {
    // The libraries' own wording, which varies between runs, stays out of the report.
    for (const diagnostic of output.diagnostics) {
      emit(io, { type: 'diagnostic', command: 'audit', source: 'image', ...diagnostic });
    }
    for (const diagnostic of output.scanDiagnostics) {
      emit(io, { type: 'diagnostic', command: 'audit', source: 'parser', ...diagnostic });
    }
    emit(io, { type: 'result', command: 'audit', exitCode: EXIT_CODES.OK, report });
    return;
  }
  const full = renderReport(report);
  const file = writeReport(root, full, null);
  if (options.full) {
    io.stdout.write(full);
    warnIfNotKept(io, file);
  } else {
    const styles = stylesFor(colourFor(io.stdout, io.env, options), io.env);
    io.stdout.write(
      renderSummary(auditSummary(report, file, nextAfterAudit(options, report)), styles),
    );
  }
  const said = output.diagnostics.length + output.scanDiagnostics.length;
  if (said > 0) {
    io.stderr.write(
      `The imaging and parsing libraries left ${said} ${said === 1 ? 'message' : 'messages'} of their own; \`upfly audit --json\` includes their text.\n`,
    );
  }
}

/**
 * The command to run after an audit: `optimize` when an image would be smaller, `dedupe`
 * when identical copies were found, with the same folder and the options that choose files.
 */
function nextAfterAudit(options: AuditOptions, report: Report): NextStep | null {
  const { findings } = report.summary;
  // `optimize` refuses to plan until the folder is named, so that comes first.
  if (findings['serving-root-unknown'] > 0) {
    return {
      words: null,
      text: 'name the folder the site serves: upfly audit --public <dir>',
    };
  }
  const command =
    findings['format-opportunity'] > 0 ? 'optimize' : findings.duplicate > 0 ? 'dedupe' : null;
  if (command === null) return null;
  return {
    words: ['upfly', command, ...scopeWords(options)],
    text: `upfly ${command}, with the same folder and options`,
  };
}

/**
 * The folder and the options that choose which files a run reads, written as they would be
 * typed again, so a next command reads the same project.
 */
export function scopeWords(options: {
  readonly dir: string;
  readonly publicDirs: readonly string[] | null;
  readonly exclude: readonly string[];
}): string[] {
  return [
    ...(options.dir === '.' ? [] : [options.dir]),
    ...(options.publicDirs ?? []).flatMap((dir) => ['--public', dir === '' ? '.' : dir]),
    ...options.exclude.flatMap((pattern) => ['--exclude', pattern]),
  ];
}

/**
 * Whether `path` names a directory.
 *
 * @param path an absolute path
 */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
