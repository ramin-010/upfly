/**
 * §5.1(d), the half a machine should do.
 *
 * The protocol says a person opens every `broken` finding and greps every dead
 * asset before believing it. The first worksheets this produced held **601
 * checkboxes with the grep command already written out** — and if the command is
 * written, the machine should run it. That is data entry, not review, and a person
 * doing it 601 times starts rubber-stamping around item forty, which is worse than
 * not checking at all.
 *
 * ⚠️ **The oracle here is deliberately NOT the engine.** No `resolve.ts`, no
 * `sweep.ts`, no adapters — a directory index built by its own walker and a grep
 * built from its own regex. An engine checking its own findings with its own logic
 * agrees with itself, which is the same rule `fixture-integrity.test.ts` follows and
 * for the same reason.
 *
 * It differs from the engine's own machinery on purpose, in three ways that are the
 * whole point:
 *
 * - it walks **everything** except `.git`, including the directories `discover`
 *   prunes and whatever `.upflyignore` excluded, because an asset referenced from a
 *   pruned directory is still referenced;
 * - it matches an asset's **stem under a different extension** as well as its exact
 *   filename, which catches the case Phase 2 will create;
 * - it decides a path exists by looking it up in the **directory index**, not with
 *   `existsSync`, because `existsSync` is case-insensitive on Windows and would
 *   report a genuine cross-platform defect as a false finding.
 *
 * Every item comes back *confirmed-genuine*, *confirmed-false* or *ambiguous* with
 * the evidence attached. Only the ambiguous ones are a person's problem.
 */

import type { Dirent } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, posix, relative } from 'node:path';
import { IMAGE_EXTENSIONS, type Report } from 'upfly-core';

export type Verdict = 'confirmed-genuine' | 'confirmed-false' | 'ambiguous';

export interface ItemVerdict {
  readonly kind: 'broken' | 'dead' | 'possibly-dead';
  /** What was checked, as the report names it. */
  readonly subject: string;
  readonly verdict: Verdict;
  /** What the oracle actually saw. A verdict without this is an opinion. */
  readonly evidence: readonly string[];
  /**
   * Items sharing this are the **same decision**, and the worksheet renders them
   * once. Twenty scaffolding fixtures all missing `/next.svg` is one judgement
   * call, and asking for it twenty times is how a worksheet goes back to being
   * 601 checkboxes nobody reads.
   */
  readonly group?: string;
}

export interface VerifyResult {
  readonly items: readonly ItemVerdict[];
  /** Files the oracle could not read, so its own coverage is not silent (rule 9). */
  readonly unreadable: readonly string[];
  readonly filesIndexed: number;
  readonly filesGrepped: number;
}

/** One mention of an asset filename found by the oracle's own grep. */
interface Hit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  /** True when the token matched the stem under a different extension. */
  readonly extensionSwapped: boolean;
}

/**
 * Everything the oracle knows about the repository, built once.
 *
 * `files` is every path as the filesystem actually spells it, so a lookup is
 * case-exact on every platform.
 */
interface RepoIndex {
  readonly files: ReadonlySet<string>;
  readonly hitsByToken: ReadonlyMap<string, readonly Hit[]>;
  readonly hitsByStem: ReadonlyMap<string, readonly Hit[]>;
  readonly unreadable: readonly string[];
  readonly filesIndexed: number;
  readonly filesGrepped: number;
}

const MAX_GREP_BYTES = 8 * 1024 * 1024;

export async function verifyFindings(
  root: string,
  report: Report,
  publicDirs: readonly string[],
): Promise<VerifyResult> {
  const index = await buildIndex(root);
  const items: ItemVerdict[] = [];

  for (const finding of report.findings) {
    if (finding.kind === 'broken') {
      items.push(verifyBroken(finding.file, finding.rawPath, index, publicDirs));
    } else if (finding.kind === 'dead') {
      items.push(verifyDead(finding.asset, index));
    } else if (finding.kind === 'possibly-dead') {
      items.push(verifyHedge(finding.asset, finding.evidence, index));
    }
  }

  return {
    items,
    unreadable: index.unreadable,
    filesIndexed: index.filesIndexed,
    filesGrepped: index.filesGrepped,
  };
}

/**
 * §5.1(d): every `broken` finding, opened.
 *
 * **One false `broken` fails the gate**, so this resolves the path the way a bundler
 * would — file-relative, then every serving root that is an ancestor of the
 * referencing file, then the project root — and answers from the directory index.
 */
function verifyBroken(
  file: string,
  rawPath: string,
  index: RepoIndex,
  publicDirs: readonly string[],
): ItemVerdict {
  const subject = `${file} → ${rawPath}`;
  const path = rawPath.split('?')[0]?.split('#')[0] ?? rawPath;
  const candidates = candidatePaths(file, path, publicDirs);

  const found = candidates.filter((candidate) => index.files.has(candidate));
  if (found.length > 0) {
    return {
      kind: 'broken',
      subject,
      verdict: 'confirmed-false',
      evidence: [`the path resolves to a file that exists: ${found.join(', ')}`],
    };
  }

  // A file of that name somewhere else in the tree is not a resolution, but it is
  // the shape of "somebody moved it" and a person should see it rather than have
  // the machine rule on it.
  const name = posix.basename(path).toLowerCase();
  const elsewhere = [...index.files].filter(
    (entry) => posix.basename(entry).toLowerCase() === name,
  );

  if (elsewhere.length > 0) {
    return {
      kind: 'broken',
      subject,
      verdict: 'ambiguous',
      group: path,
      evidence: [
        `nothing serves ${path} to this file: none of ${candidates.length} candidate paths exist.`,
        `The name does exist at ${elsewhere.slice(0, 4).join(', ')}${elsewhere.length > 4 ? ` (+${elsewhere.length - 4} more)` : ''},`,
        'but none of those directories serve this file, so they are not resolutions.',
        'The engine is right that nothing serves it here. What a person has to decide is',
        'whether a reference to a file the app never ships is a finding worth reporting.',
      ],
    };
  }

  return {
    kind: 'broken',
    subject,
    verdict: 'confirmed-genuine',
    evidence: [
      `none of ${candidates.length} candidate paths exist: ${candidates.slice(0, 4).join(', ')}`,
      `and no file named ${posix.basename(path)} exists anywhere in the repository`,
    ],
  };
}

/**
 * Every place a bundler could actually serve this path from.
 *
 * ⚠️ **Proximity filters; it does not merely order.** The first version of this
 * function tried every configured serving root and reported 19 of shadcn-ui's 20
 * `broken` findings as false, on evidence like *"`/next.svg` resolves to
 * `apps/v4/public/next.svg`"* — for a file under
 * `packages/shadcn/test/fixtures/frameworks/next-app/`, which `apps/v4` does not
 * serve. That is precisely the cross-app false link R13's correction was issued to
 * remove, reimplemented here and then used to "disprove" the engine that had already
 * fixed it.
 *
 * The lesson is worth more than the fix: an independent oracle has to be independent
 * in **implementation**, not in **correctness**. Modelling how static serving works
 * is not copying the engine — it is the ground truth both are trying to match.
 *
 * A serving root `apps/v4/public` serves the app rooted at `apps/v4`, so it applies
 * only to files underneath it. Ancestor `public/` directories are tried the same way,
 * which is what auto-detection would find.
 */
function candidatePaths(
  file: string,
  path: string,
  publicDirs: readonly string[],
): readonly string[] {
  const candidates: string[] = [];

  if (path.startsWith('/')) {
    const bare = path.slice(1);

    for (const dir of publicDirs) {
      const appRoot = dir === '' ? '.' : posix.dirname(dir);
      if (appRoot === '.' || file.startsWith(`${appRoot}/`)) {
        candidates.push(dir === '' ? bare : posix.join(dir, bare));
      }
    }

    let directory = posix.dirname(file);
    while (directory !== '.' && directory !== '/') {
      candidates.push(posix.join(directory, 'public', bare));
      directory = posix.dirname(directory);
    }

    // The project root, for a plain static site that serves from the top.
    candidates.push(posix.join('public', bare));
    candidates.push(bare);
  } else {
    candidates.push(posix.normalize(posix.join(posix.dirname(file), path)));
    // A `./`-spelled path meant relative to the project root — R15's case.
    candidates.push(posix.normalize(path));
  }

  return [...new Set(candidates)].filter((candidate) => !candidate.startsWith('..'));
}

/**
 * §5.1(d): every `dead` asset, grepped across the whole repository.
 *
 * `dead` is the strong claim — *this filename appears nowhere in your codebase* — so
 * this is the claim most worth attacking. The oracle greps places the engine
 * deliberately does not: pruned directories, ignored ones, and the asset's stem
 * under a different extension.
 */
function verifyDead(asset: string, index: RepoIndex): ItemVerdict {
  const name = posix.basename(asset).toLowerCase();
  const stem = name.slice(0, name.lastIndexOf('.'));

  const exact = (index.hitsByToken.get(name) ?? []).filter((hit) => hit.file !== asset);
  if (exact.length > 0) {
    return {
      kind: 'dead',
      subject: asset,
      verdict: 'confirmed-false',
      evidence: [
        `the filename appears in ${exact.length} place(s) the engine did not hedge on:`,
        ...exact.slice(0, 5).map((hit) => `  ${hit.file}:${hit.line}  ${hit.text}`),
      ],
    };
  }

  const swapped = (index.hitsByStem.get(stem) ?? []).filter(
    (hit) => hit.extensionSwapped && hit.file !== asset,
  );
  if (swapped.length > 0) {
    return {
      kind: 'dead',
      subject: asset,
      verdict: 'ambiguous',
      evidence: [
        'the exact filename appears nowhere, but the same name under another image',
        'extension does — which is either an unrelated asset or a reference someone',
        'already converted by hand:',
        ...swapped.slice(0, 5).map((hit) => `  ${hit.file}:${hit.line}  ${hit.text}`),
      ],
    };
  }

  return {
    kind: 'dead',
    subject: asset,
    verdict: 'confirmed-genuine',
    evidence: [
      `grepped ${index.filesGrepped} files including pruned and ignored directories:`,
      `no mention of ${posix.basename(asset)} anywhere, under any image extension`,
    ],
  };
}

/**
 * §5.1(d): every hedge's citation, opened.
 *
 * `possibly-dead` is not exempt from review, and the thing to check is not whether
 * the asset is alive — the hedge does not claim to know — but whether the citation
 * is **real**. A hedge pointing at a line that does not contain the name is worse
 * than no hedge: it sends a user somewhere and wastes the trust the citation bought.
 */
function verifyHedge(
  asset: string,
  evidence: readonly { where: string; quote: string; source: string }[],
  index: RepoIndex,
): ItemVerdict {
  const checked: string[] = [];
  const wrong: string[] = [];

  for (const mention of evidence) {
    const match = /^(.*?):(\d+)$/.exec(mention.where);
    const file = match?.[1] ?? mention.where;
    const line = match?.[2] === undefined ? null : Number(match[2]);

    if (!index.files.has(file)) {
      wrong.push(`${mention.where} — that file is not in the repository`);
      continue;
    }

    const token = posix.basename(asset).toLowerCase();
    const hits = index.hitsByToken.get(token) ?? [];
    const inFile = hits.filter((hit) => hit.file === file);

    if (inFile.length === 0) {
      wrong.push(`${mention.where} — the file does not contain ${posix.basename(asset)}`);
    } else if (line !== null && !inFile.some((hit) => hit.line === line)) {
      wrong.push(
        `${mention.where} — the name is in that file but on line(s) ${inFile
          .map((hit) => hit.line)
          .slice(0, 4)
          .join(', ')}, not ${line}`,
      );
    } else {
      checked.push(`${mention.where} (${mention.source}) — the name is there`);
    }
  }

  if (wrong.length > 0) {
    return {
      kind: 'possibly-dead',
      subject: asset,
      verdict: 'confirmed-false',
      evidence: ['a citation does not hold up:', ...wrong.map((entry) => `  ${entry}`)],
    };
  }

  return {
    kind: 'possibly-dead',
    subject: asset,
    verdict: 'confirmed-genuine',
    evidence: checked.map((entry) => `  ${entry}`),
  };
}

/** The oracle's own walk and grep. Nothing here imports the engine's machinery. */
async function buildIndex(root: string): Promise<RepoIndex> {
  const files = new Set<string>();
  const hitsByToken = new Map<string, Hit[]>();
  const hitsByStem = new Map<string, Hit[]>();
  const unreadable: string[] = [];
  let filesGrepped = 0;

  const extensions = IMAGE_EXTENSIONS.map((extension) => extension.slice(1)).join('|');
  const pattern = new RegExp(`[\\w@.\\-]+\\.(?:${extensions})\\b`, 'gi');

  for await (const absolute of walk(root)) {
    const rel = relative(root, absolute).replaceAll('\\', '/');
    files.add(rel);

    const extension = rel.slice(rel.lastIndexOf('.')).toLowerCase();
    if (IMAGE_EXTENSIONS.includes(extension)) continue;

    let text: string;
    try {
      text = await readFile(absolute, 'utf8');
    } catch (error) {
      unreadable.push(`${rel} — ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (text.length > MAX_GREP_BYTES) {
      unreadable.push(`${rel} — larger than ${MAX_GREP_BYTES} bytes, not grepped`);
      continue;
    }
    // Built with `String.fromCharCode` on purpose: a literal NUL in a source file
    // is exactly the character this harness mangles in transit, and it did.
    if (text.includes(String.fromCharCode(0))) {
      unreadable.push(`${rel} — contains a NUL byte, treated as binary and not grepped`);
      continue;
    }
    filesGrepped += 1;

    const lineStarts = offsetsOfLines(text);
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match !== null) {
      const token = match[0].toLowerCase();
      const stem = token.slice(0, token.lastIndexOf('.'));
      const line = lineOf(lineStarts, match.index);
      const hit: Hit = {
        file: rel,
        line,
        text: lineText(text, match.index),
        extensionSwapped: false,
      };
      hitsByToken.set(token, [...(hitsByToken.get(token) ?? []), hit]);
      hitsByStem.set(stem, [...(hitsByStem.get(stem) ?? []), { ...hit, extensionSwapped: true }]);
      match = pattern.exec(text);
    }
  }

  return { files, hitsByToken, hitsByStem, unreadable, filesIndexed: files.size, filesGrepped };
}

/**
 * Everything but `.git`.
 *
 * Deliberately not `discover`'s prune list: an asset referenced from `dist/` or from
 * a directory the user ignored is still referenced, and the point of an independent
 * oracle is to look where the engine agreed not to.
 */
async function* walk(directory: string): AsyncGenerator<string> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '.git') yield* walk(path);
    } else if (entry.isFile()) {
      yield path;
    }
  }
}

function offsetsOfLines(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

/** Binary search rather than a scan per match: some of these files are large. */
function lineOf(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((starts[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

function lineText(text: string, offset: number): string {
  const start = text.lastIndexOf('\n', offset) + 1;
  const end = text.indexOf('\n', offset);
  return text
    .slice(start, end === -1 ? undefined : end)
    .trim()
    .slice(0, 140);
}
