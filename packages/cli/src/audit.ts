/** `upfly audit`: the report, and nothing written anywhere. */

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
import { type Io, emit, progressReporter, stopWith } from './output.js';

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
    ...(output.probes === undefined ? {} : { probes: output.probes }),
    includeDiscarded: options.includeDiscarded,
    includeUnusedVectors: options.includeUnusedSvg,
  });
  write(options, io, report, output);
  return EXIT_CODES.OK;
}

function probeOptionsFor(options: AuditOptions, format: 'webp' | 'avif') {
  if (!options.probe) return null;
  return {
    formats: [format],
    ...(options.maxEncodes === null ? {} : { maxEncodedAssets: options.maxEncodes }),
  };
}

function write(options: AuditOptions, io: Io, report: Report, output: PipelineOutput): void {
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
  io.stdout.write(renderReport(report));
  const said = output.diagnostics.length + output.scanDiagnostics.length;
  if (said > 0) {
    io.stderr.write(
      `The imaging and parsing libraries left ${said} ${said === 1 ? 'message' : 'messages'} of their own about the files above; \`upfly audit --json\` includes them.\n`,
    );
  }
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
