/**
 * The short summaries `audit`, `optimize` and `dedupe` print by default: what will happen or
 * happened, the totals, what is left alone grouped by reason, and what to run next. The full
 * text goes to the report file, and `--full` prints it instead.
 */

import type {
  DedupePlan,
  EncodeFormat,
  Manifest,
  OptimizationPlan,
  PublicPolicy,
  Report,
} from 'upfly-core';
import { type AssetProbe, type Graph, formatBytes } from 'upfly-core/internal';
import type { Savings } from './audit.js';
import { type GitState, insideRepository } from './git.js';
import { type Row, type Summary, VALUE_WIDTH, columns, commandLine } from './layout.js';
import { count, writtenByKind } from './plan-text.js';
import { countGroups, declineGroup, formatName, stayGroup, unmeasuredGroup } from './reasons.js';
import type { ReportFile } from './report-file.js';

/** What to do next: a command to copy, or words when no single command will do. */
export interface NextStep {
  /** The command, word by word, or null when the step is not one command. */
  readonly words: readonly string[] | null;
  /** What is printed when there is no command, or when it is too long to print whole. */
  readonly text: string;
  readonly details?: readonly string[];
}

/** The summary of an audit. */
export function auditSummary(
  report: Report,
  savings: Savings | null,
  file: ReportFile,
  next: NextStep | null,
): Summary {
  const { summary } = report;
  const references =
    summary.references === 0
      ? [`none, in ${count(summary.sourceFiles, 'source file')}`]
      : [
          `${summary.linkedReferences} of ${summary.references}`,
          ` resolved, from ${count(summary.sourceFiles, 'source file')}`,
        ];
  return {
    command: 'audit',
    sections: [
      [
        {
          label: 'Images',
          value: [count(summary.assets, 'image'), `, ${formatBytes(summary.assetBytes)}`],
        },
        { label: 'References', value: references },
        savingsRow(report, savings),
        brokenRow(report),
        unusedRow(report),
        ...oversizedRows(report),
        copiesRow(report),
        skippedRow(report),
      ],
      [reportRow('Full report', file), ...nextRows(next)],
    ],
  };
}

/**
 * What `optimize` would convert and save with the same options: the plan's own figure, so
 * an image it would not convert is never counted. Past the cap it is a part of the plan,
 * marked "at least", with the number of images left unmeasured.
 */
function savingsRow(report: Report, savings: Savings | null): Row {
  const { summary } = report;
  const label = 'Savings';
  if (!summary.probed) return { label, value: ['not measured, as --no-probe asked'] };
  if (savings === null) {
    return { label, value: ['not planned: where the site is served from is unknown'] };
  }
  const { conversions, unmeasured } = savings;
  const details = [
    ...(unmeasured === 0
      ? []
      : [
          `${count(unmeasured, 'more image')} optimize may convert ${unmeasured === 1 ? 'was' : 'were'} not measured; --probe-all measures them`,
        ]),
    ...(summary.unmeasuredAssets === 0
      ? []
      : [`${count(summary.unmeasuredAssets, 'image')} could not be measured`]),
  ];
  if (conversions.length === 0) {
    return {
      label,
      value: [unmeasured === 0 ? 'none: optimize would convert no image' : 'none found so far'],
      details,
    };
  }
  const [first] = conversions;
  const quality = qualityPhrase([...new Set(conversions.map((conversion) => conversion.quality))]);
  return {
    label,
    value: [
      `${unmeasured === 0 ? '' : 'at least '}${formatBytes(savings.savedBytes)}`,
      ` as ${formatName(first?.format ?? 'webp')}${quality === '' ? '' : ` ${quality}`}, across ${count(conversions.length, 'image')}`,
    ],
    details,
  };
}

/** The settings a saving was measured at: `at quality 80`, `lossless`, or both. */
function qualityPhrase(settings: readonly (number | 'lossless')[]): string {
  const numbers = settings
    .filter((setting): setting is number => setting !== 'lossless')
    .sort((a, b) => a - b);
  const quality = numbers.length === 0 ? '' : `at quality ${numbers.join(' or ')}`;
  if (!settings.includes('lossless')) return quality;
  return quality === '' ? 'lossless' : `${quality}, or lossless`;
}

function brokenRow(report: Report): Row {
  const label = 'Broken';
  if (report.findings.some((finding) => finding.kind === 'serving-root-unknown')) {
    return {
      label,
      value: ['not judged: where the site is served from is unknown'],
      details: ['name the folder with --public <dir>; the full report says more'],
    };
  }
  const broken = report.summary.findings.broken;
  if (broken === 0) return { label, value: ['none'] };
  return {
    label,
    value: [
      count(broken, 'reference'),
      ` ${broken === 1 ? 'names' : 'name'} an image that does not exist`,
    ],
  };
}

function unusedRow(report: Report): Row {
  const dead = report.findings.filter((finding) => finding.kind === 'dead');
  const bytes = dead.reduce((sum, finding) => sum + finding.bytes, 0);
  const possibly = report.summary.findings['possibly-dead'];
  const vectors = report.unusedVectors.count;
  const kept = report.keptOriginals.count;
  return {
    label: 'Unused',
    value: dead.length === 0 ? ['none'] : [count(dead.length, 'image'), `, ${formatBytes(bytes)}`],
    details: [
      ...(possibly === 0
        ? []
        : [
            `${possibly} possibly unused: ${possibly === 1 ? 'its name appears' : 'their names appear'} in the project`,
          ]),
      ...(vectors === 0 ? [] : [`and ${count(vectors, 'unreferenced SVG')}, counted, not listed`]),
      ...(kept === 0
        ? []
        : [`${count(kept, 'original')} kept beside converted files are not counted`]),
    ],
  };
}

function oversizedRows(report: Report): Row[] {
  const oversized = report.summary.findings.oversized;
  if (oversized === 0) return [];
  return [{ label: 'Oversized', value: [count(oversized, 'image'), ' over the limits'] }];
}

function copiesRow(report: Report): Row {
  const sets = report.findings.filter((finding) => finding.kind === 'duplicate');
  if (sets.length === 0) return { label: 'Copies', value: ['none'] };
  const wasted = sets.reduce((sum, finding) => sum + finding.wastedBytes, 0);
  return {
    label: 'Copies',
    value: [count(sets.length, 'set'), ` of identical images, ${formatBytes(wasted)} recoverable`],
  };
}

/** What each stage's skipped entries are, after their count. */
const SKIPPED: Readonly<Record<string, readonly [string, string]>> = {
  discovery: ['file', 'could not be read'],
  scan: ['file', 'could not be parsed'],
  sweep: ['file', 'too large to search for image names'],
  citation: ['file', 'could not be read again for a line number'],
  aliases: ['config', 'had path aliases Upfly could not read'],
};

function skippedRow(report: Report): Row {
  // The measurements past the encode cap are in the savings row, so the image count here is
  // the one the report keeps for failed measurements.
  const groups = new Map<string, number>();
  for (const item of report.skipped) {
    if (item.stage === 'measurement') continue;
    groups.set(item.stage, (groups.get(item.stage) ?? 0) + 1);
  }
  const counts = [...groups].map(([stage, n]) => {
    const [noun, what] = SKIPPED[stage] ?? ['item', 'skipped'];
    return { count: n, text: `${n === 1 ? noun : `${noun}s`} ${what}` };
  });
  const unmeasured = report.summary.unmeasuredAssets;
  if (unmeasured > 0) {
    counts.push({
      count: unmeasured,
      text: `${unmeasured === 1 ? 'image' : 'images'} could not be measured`,
    });
  }
  if (counts.length === 0) return { label: 'Skipped', value: ['nothing'] };
  const total = counts.reduce((sum, entry) => sum + entry.count, 0);
  return {
    label: 'Skipped',
    value: [String(total), ', each with its reason in the full report'],
    counts,
  };
}

/** What `optimize` planned or did, and what the summary needs to say it. */
export interface OptimizeFacts {
  readonly plan: OptimizationPlan;
  readonly graph: Graph;
  readonly probes: readonly AssetProbe[] | undefined;
  /** The images `--only` named, or null when every image could convert. */
  readonly only: readonly string[] | null;
  readonly format: EncodeFormat;
  readonly policy: PublicPolicy;
  readonly apply: boolean;
  readonly manifest: Manifest | null;
  readonly commit: string | null;
  readonly git: GitState;
  readonly notes: readonly string[];
  readonly file: ReportFile;
  readonly next: NextStep | null;
}

/** The summary of an `optimize` run, dry or applied. */
export function optimizeSummary(facts: OptimizeFacts): Summary {
  const { plan, apply } = facts;
  const sizes = new Map(facts.graph.assets.map((node) => [node.asset.relative, node.asset.bytes]));
  const before = plan.conversions.reduce((sum, c) => sum + (sizes.get(c.asset) ?? 0), 0);
  const saved = plan.conversions.reduce((sum, c) => sum + c.savedBytes, 0);
  const format = plan.conversions[0]?.format ?? facts.format;

  const convert: Row = {
    label: apply ? 'Converted' : 'Convert',
    value:
      plan.conversions.length === 0
        ? ['no image']
        : [
            count(plan.conversions.length, 'image'),
            ` to ${formatName(format)}, `,
            `${formatBytes(before)} → ${formatBytes(before - saved)}`,
          ],
    details:
      plan.conversions.length === 0 ? [] : originalsDetails(plan, facts.policy, apply, sizes),
  };

  const assets = new Set(sizes.keys());
  const references = plan.rewrites.reduce((sum, rewrite) => sum + rewrite.edits.length, 0);
  const stay = plan.declined.filter((entry) => !assets.has(entry.path)).length;
  const update: Row = {
    label: apply ? 'Updated' : 'Update',
    value:
      references === 0
        ? ['no reference']
        : [count(references, 'reference'), ` in ${count(plan.rewrites.length, 'file')}`],
    details:
      stay === 0
        ? []
        : [
            `${count(stay, 'other reference')} ${stay === 1 ? 'stays' : 'stay'} as written, each for a reason in the full plan`,
          ],
  };

  return {
    command: 'optimize',
    mode: apply ? 'applied' : 'dry run',
    sections: [
      [convert, update, leaveRow(facts, sizes)],
      noteRows(facts.notes, facts.git),
      [
        ...runRows(facts),
        ...repositoryRows(facts),
        reportRow('Full plan', facts.file),
        ...nextRows(facts.next),
      ],
    ],
    ...(apply ? {} : { closing: 'Dry run: no project file was changed.' }),
  };
}

/**
 * What happens to the originals: how many go and their size, how many stay, and before a run
 * that removes any, what a removed original costs. An original is removed only from a folder
 * the site is served from, so a link from outside the project may name any of them.
 */
function originalsDetails(
  plan: OptimizationPlan,
  policy: PublicPolicy,
  apply: boolean,
  sizes: ReadonlyMap<string, number>,
): string[] {
  if (policy === 'keep-original') return ['each original stays beside its new file'];
  const removed = plan.conversions.filter((conversion) => conversion.replacesOriginal);
  const bytes = formatBytes(removed.reduce((sum, c) => sum + (sizes.get(c.asset) ?? 0), 0));
  const kept = plan.keptOriginals.length;
  const originals = count(removed.length, 'original');
  return [
    ...(removed.length === 0
      ? []
      : apply
        ? [`${originals} removed, ${bytes}, since their references moved`]
        : [
            `${originals} to remove, ${bytes}, once their references move`,
            'a link to one from outside the project (an email, another site, a CMS) then stops working; --keep-originals keeps them',
          ]),
    ...(kept === 0 ? [] : [`${count(kept, 'original')} kept, each for a reason in the full plan`]),
  ];
}

/** Every image that does not convert, counted by why. */
function leaveRow(facts: OptimizeFacts, sizes: ReadonlyMap<string, number>): Row {
  const converting = new Set(facts.plan.conversions.map((conversion) => conversion.asset));
  const declined = new Map<string, string>();
  for (const entry of facts.plan.declined) {
    if (sizes.has(entry.path) && !declined.has(entry.path)) declined.set(entry.path, entry.reason);
  }
  const probes = new Map((facts.probes ?? []).map((probe) => [probe.relative, probe]));
  const only = facts.only === null ? null : new Set(facts.only);

  const groups: string[] = [];
  let bytes = 0;
  for (const [path, size] of sizes) {
    if (converting.has(path)) continue;
    bytes += size;
    const reason = declined.get(path);
    if (reason !== undefined) groups.push(declineGroup(reason));
    else if (only !== null && !only.has(path)) groups.push('left out by --only');
    else groups.push(unmeasuredGroup(probes.get(path)?.skipped[0]?.code ?? null, facts.format));
  }
  return {
    label: facts.apply ? 'Left alone' : 'Leave',
    value:
      groups.length === 0
        ? ['no image']
        : [count(groups.length, 'image'), `, ${formatBytes(bytes)}`],
    counts: countGroups(groups),
  };
}

/** The applied run's record and commit, as rows. */
function runRows(facts: {
  readonly apply: boolean;
  readonly manifest: Manifest | null;
  readonly commit: string | null;
  readonly git: GitState;
}): Row[] {
  if (!facts.apply) return [];
  if (facts.manifest === null) {
    return [{ label: 'Run', value: ['nothing written: the plan has nothing to do'] }];
  }
  const { created, changed, removed } = writtenByKind(facts.manifest);
  const rows: Row[] = [
    {
      label: 'Run',
      value: [
        `${facts.manifest.runId}: `,
        `${count(created.length, 'file')} created, ${changed.length} changed, ${removed.length} removed`,
      ],
    },
  ];
  if (facts.commit !== null && facts.git.kind === 'repository') {
    rows.push({
      label: 'Commit',
      value: [facts.commit.slice(0, 12), ', exactly the files the run wrote'],
    });
  }
  return rows;
}

/**
 * The repository a commit is made in, when the project is a folder of a larger one: before
 * `--apply`, and after a run that committed. Its top is printed whole, since a path cut short
 * in the middle would not say where.
 */
function repositoryRows(facts: {
  readonly apply: boolean;
  readonly commit: string | null;
  readonly git: GitState;
}): Row[] {
  const { git } = facts;
  if (git.kind !== 'repository' || git.prefix === '') return [];
  if (facts.apply && facts.commit === null) return [];
  return [
    {
      label: 'Repository',
      value: [`${git.prefix} in the git repository at ${git.top}`],
      whole: true,
      details: [
        facts.apply
          ? 'the commit holds only the files under it'
          : '--apply checks, and --commit commits, only the files under it',
      ],
    },
  ];
}

/** The notes as rows, but the one the repository row says. */
function noteRows(notes: readonly string[], git: GitState): Row[] {
  const inside = insideRepository(git);
  return notes.filter((note) => note !== inside).map((note) => ({ label: 'Note', value: [note] }));
}

/** What a `dedupe` run planned or did, and what the summary needs to say it. */
export interface DedupeFacts {
  readonly plan: DedupePlan;
  readonly apply: boolean;
  readonly manifest: Manifest | null;
  readonly commit: string | null;
  readonly git: GitState;
  readonly notes: readonly string[];
  readonly file: ReportFile;
  readonly next: NextStep | null;
}

/** The summary of a `dedupe` run, dry or applied. */
export function dedupeSummary(facts: DedupeFacts): Summary {
  const { plan, apply } = facts;
  const files = plan.sets.reduce((sum, set) => sum + 1 + set.copies.length, 0);
  const references = plan.rewrites.reduce((sum, rewrite) => sum + rewrite.edits.length, 0);
  const stays = plan.sets.flatMap((set) => set.copies.flatMap((copy) => copy.stays));
  const unused = plan.sets.flatMap((set) =>
    set.copies.filter((copy) => copy.unusedAfter).map(() => set.bytes),
  );

  const rows: Row[] = [
    {
      label: 'Sets',
      value:
        plan.sets.length === 0
          ? ['none: no two images hold the same bytes']
          : [count(plan.sets.length, 'set'), ` of identical images, ${count(files, 'file')}`],
    },
  ];
  if (plan.sets.length > 0) {
    rows.push({
      label: apply ? 'Updated' : 'Update',
      value:
        references === 0
          ? ['no reference']
          : [count(references, 'reference'), ` in ${count(plan.rewrites.length, 'file')}`],
    });
  }
  if (stays.length > 0) {
    rows.push({
      label: apply ? 'Left alone' : 'Leave',
      value: [count(stays.length, 'reference'), ' as written'],
      counts: countGroups(stays.map((stay) => stayGroup(stay.why))),
    });
  }
  if (unused.length > 0) {
    const one = unused.length === 1;
    rows.push({
      label: 'Unused',
      value: [
        one ? '1 copy' : `${unused.length} copies`,
        `, ${formatBytes(unused.reduce((sum, bytes) => sum + bytes, 0))}, with no reference left`,
      ],
      details: [
        `Upfly never deletes ${one ? 'it' : 'them'}; upfly audit lists ${one ? 'it' : 'them'} as unused`,
      ],
    });
  }

  return {
    command: 'dedupe',
    mode: apply ? 'applied' : 'dry run',
    sections: [
      rows,
      noteRows(facts.notes, facts.git),
      [
        ...runRows(facts),
        ...repositoryRows(facts),
        reportRow('Full plan', facts.file),
        ...nextRows(facts.next),
      ],
    ],
    ...(apply ? {} : { closing: 'Dry run: no project file was changed.' }),
  };
}

function reportRow(label: string, file: ReportFile): Row {
  if ('written' in file) return { label, value: [file.written] };
  return {
    label,
    value: [`not written (${file.failed})`],
    details: ['add --full to print it here instead'],
  };
}

function nextRows(next: NextStep | null): Row[] {
  if (next === null) return [];
  const line = next.words === null ? null : commandLine(next.words);
  const command = line !== null && columns(line) <= VALUE_WIDTH ? line : null;
  return [
    {
      label: 'Next',
      value: [command ?? next.text],
      bold: command !== null,
      ...(next.details === undefined ? {} : { details: next.details }),
    },
  ];
}

/**
 * What to run after a plan: the same command with `--apply`, or what has to happen first
 * when git or an unfinished run would refuse it.
 *
 * @param command the command that made the plan
 * @param dir the project folder as given, or `.`
 * @param flags the flags that shaped the plan, to repeat with `--apply`
 * @param git what git said about the folder
 * @param unfinished whether an earlier run stopped part way
 */
export function nextAfterPlan(
  command: 'optimize' | 'dedupe',
  dir: string,
  flags: readonly string[],
  git: GitState,
  unfinished: boolean,
): NextStep {
  const folder = dir === '.' ? [] : [dir];
  if (unfinished) {
    return {
      words: ['upfly', 'undo', ...folder],
      text: 'upfly undo, to finish the earlier run first',
    };
  }
  const run = ['upfly', command, ...folder, ...flags, '--apply'];
  if (git.kind !== 'repository' || !git.tracked) {
    return {
      words: [...run, '--allow-dirty'],
      text: 'the same command with --apply --allow-dirty',
    };
  }
  if (git.changed.some((path) => path !== '.upfly' && !path.startsWith('.upfly/'))) {
    return { words: null, text: 'commit or stash your changes, then add --apply' };
  }
  return { words: run, text: 'the same command with --apply' };
}

/**
 * What to do after an applied run: check it, with the ways back.
 *
 * @param commit the run's commit, or null
 */
export function nextAfterRun(commit: string | null): NextStep {
  return {
    words: null,
    text: "run the project's build, if it has one, then upfly check",
    details: [
      'upfly undo puts every file back',
      ...(commit === null ? [] : [`git revert ${commit.slice(0, 12)} undoes the commit`]),
    ],
  };
}
